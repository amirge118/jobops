import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { canonicalizeJobUrl, normalizeCompanyRole } from './core.mjs';

function stableJobKey(canonicalUrl) {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
}

function parseSources(value) {
  try {
    return Array.isArray(JSON.parse(value)) ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createJobStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_key          TEXT PRIMARY KEY,
      canonical_url    TEXT NOT NULL UNIQUE,
      apply_url        TEXT NOT NULL,
      company_role_key TEXT,
      company          TEXT,
      title            TEXT,
      summary          TEXT,
      score            REAL,
      fit_label        TEXT,
      decision_reason  TEXT,
      fit_breakdown_json TEXT,
      suitable         INTEGER NOT NULL DEFAULT 0,
      active_status    TEXT NOT NULL DEFAULT 'unknown',
      content_hash     TEXT,
      profile_hash     TEXT,
      criteria_version TEXT,
      sources_json     TEXT NOT NULL DEFAULT '[]',
      first_seen_at    INTEGER NOT NULL,
      last_seen_at     INTEGER NOT NULL,
      evaluated_at     INTEGER,
      presented_at     INTEGER,
      opened_at        INTEGER,
      archived_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS jobs_company_role_idx ON jobs(company_role_key);
    CREATE INDEX IF NOT EXISTS jobs_suitable_idx ON jobs(suitable, presented_at, opened_at);

    CREATE TABLE IF NOT EXISTS job_pages (
      canonical_url TEXT PRIMARY KEY,
      final_url     TEXT NOT NULL,
      status        TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      fetched_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id    TEXT PRIMARY KEY,
      group_jid     TEXT NOT NULL,
      wa_timestamp  INTEGER,
      message_text  TEXT,
      status        TEXT NOT NULL,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      source_key     TEXT PRIMARY KEY,
      last_timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      from_ts     INTEGER NOT NULL,
      to_ts       INTEGER NOT NULL,
      sources     TEXT NOT NULL,
      status      TEXT NOT NULL,
      error       TEXT,
      details_json TEXT
    );
  `);

  const runColumns = db.prepare('PRAGMA table_info(runs)').all();
  if (!runColumns.some((column) => column.name === 'details_json')) {
    db.exec('ALTER TABLE runs ADD COLUMN details_json TEXT');
  }

  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all();
  if (!jobColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }
  if (!jobColumns.some((column) => column.name === 'fit_breakdown_json')) {
    db.exec('ALTER TABLE jobs ADD COLUMN fit_breakdown_json TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS jobs_archived_idx ON jobs(archived_at)');

  const processedMessageColumns = db.prepare('PRAGMA table_info(processed_messages)').all();
  if (!processedMessageColumns.some((column) => column.name === 'message_text')) {
    db.exec('ALTER TABLE processed_messages ADD COLUMN message_text TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS processed_messages_pending_idx
    ON processed_messages(group_jid, status, wa_timestamp)
  `);

  // Rejected jobs keep only identity/cache fields needed to avoid repeat work.
  db.exec(`
    UPDATE jobs SET
      company = NULL,
      title = NULL,
      summary = NULL,
      score = NULL,
      fit_label = NULL,
      decision_reason = NULL,
      fit_breakdown_json = NULL,
      apply_url = canonical_url,
      sources_json = '[]'
    WHERE suitable = 0 AND evaluated_at IS NOT NULL
  `);

  db.exec(`
    UPDATE jobs SET
      company = NULL,
      title = NULL,
      summary = NULL,
      score = NULL,
      fit_label = NULL,
      decision_reason = NULL,
      fit_breakdown_json = NULL,
      suitable = 0,
      active_status = 'archived',
      apply_url = canonical_url,
      sources_json = '[]',
      content_hash = NULL,
      profile_hash = NULL,
      criteria_version = NULL,
      evaluated_at = NULL,
      presented_at = NULL,
      opened_at = NULL
    WHERE archived_at IS NOT NULL
  `);

  const findByIdentity = db.prepare(`
    SELECT * FROM jobs
    WHERE canonical_url = @canonicalUrl
       OR (@companyRoleKey <> '::' AND company_role_key = @companyRoleKey)
    ORDER BY canonical_url = @canonicalUrl DESC
    LIMIT 1
  `);

  return {
    recordSighting({ url, company = '', title = '', source, seenAt = Date.now() }) {
      const canonicalUrl = canonicalizeJobUrl(url);
      if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);
      const companyRoleKey = normalizeCompanyRole(company, title);
      const existing = findByIdentity.get({ canonicalUrl, companyRoleKey });

      if (existing) {
        if (existing.archived_at) {
          db.prepare('UPDATE jobs SET last_seen_at = ? WHERE job_key = ?').run(seenAt, existing.job_key);
          return { jobKey: existing.job_key, canonicalUrl: existing.canonical_url, isNew: false };
        }
        const sources = new Set(parseSources(existing.sources_json));
        if (source) sources.add(source);
        db.prepare(`
          UPDATE jobs
          SET last_seen_at = @seenAt,
              apply_url = CASE WHEN canonical_url = @canonicalUrl THEN @url ELSE apply_url END,
              sources_json = @sources
          WHERE job_key = @jobKey
        `).run({ seenAt, canonicalUrl, url, sources: JSON.stringify([...sources]), jobKey: existing.job_key });
        return { jobKey: existing.job_key, canonicalUrl: existing.canonical_url, isNew: false };
      }

      const jobKey = stableJobKey(canonicalUrl);
      db.prepare(`
        INSERT INTO jobs (
          job_key, canonical_url, apply_url, company_role_key, company, title,
          sources_json, first_seen_at, last_seen_at
        ) VALUES (
          @jobKey, @canonicalUrl, @url, @companyRoleKey, @company, @title,
          @sources, @seenAt, @seenAt
        )
      `).run({
        jobKey,
        canonicalUrl,
        url,
        companyRoleKey,
        company,
        title,
        sources: JSON.stringify(source ? [source] : []),
        seenAt,
      });
      return { jobKey, canonicalUrl, isNew: true };
    },

    getJob(jobKey) {
      return db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(jobKey) ?? null;
    },

    countJobs() {
      return db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
    },

    getDashboardSnapshot() {
      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' THEN 1 ELSE 0 END) AS suitable,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' AND opened_at IS NULL THEN 1 ELSE 0 END) AS unopened
        FROM jobs
      `).get();
      const jobs = db.prepare(`
        SELECT
          job_key AS jobKey,
          company,
          title,
          summary,
          score,
          fit_label AS fitLabel,
          decision_reason AS decisionReason,
          fit_breakdown_json AS fitBreakdownJson,
          apply_url AS applyUrl,
          suitable,
          active_status AS activeStatus,
          last_seen_at AS lastSeenAt,
          opened_at AS openedAt
        FROM jobs
        WHERE archived_at IS NULL
          AND evaluated_at IS NOT NULL AND suitable = 1 AND active_status = 'active'
        ORDER BY last_seen_at DESC, score DESC
        LIMIT 500
      `).all().map((job) => ({
        ...Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'fitBreakdownJson')),
        fitBreakdown: parseJson(job.fitBreakdownJson, null),
        suitable: Boolean(job.suitable),
      }));

      return {
        stats: {
          total: Number(stats.total || 0),
          suitable: Number(stats.suitable || 0),
          unopened: Number(stats.unopened || 0),
        },
        jobs,
        lastRun: this.getLastRun(),
      };
    },

    needsEvaluation(jobKey, { contentHash, profileHash, criteriaVersion, activeStatus }) {
      const job = this.getJob(jobKey);
      if (job?.archived_at) return false;
      if (!job?.evaluated_at) return true;
      return job.content_hash !== contentHash ||
        job.profile_hash !== profileHash ||
        job.criteria_version !== criteriaVersion ||
        (activeStatus && job.active_status !== activeStatus);
    },

    saveEvaluation(jobKey, evaluation) {
      const existing = this.getJob(jobKey);
      if (!existing) throw new Error(`Unknown job: ${jobKey}`);
      const suitable = Boolean(evaluation.suitable);
      db.prepare(`
        UPDATE jobs SET
          company = @company,
          title = @title,
          company_role_key = @companyRoleKey,
          summary = @summary,
          score = @score,
          fit_label = @fitLabel,
          decision_reason = @decisionReason,
          fit_breakdown_json = @fitBreakdownJson,
          suitable = @suitable,
          apply_url = @applyUrl,
          active_status = @activeStatus,
          content_hash = @contentHash,
          profile_hash = @profileHash,
          criteria_version = @criteriaVersion,
          evaluated_at = @evaluatedAt,
          sources_json = @sources
        WHERE job_key = @jobKey
      `).run({
        ...evaluation,
        companyRoleKey: normalizeCompanyRole(evaluation.company, evaluation.title),
        company: suitable ? evaluation.company : null,
        title: suitable ? evaluation.title : null,
        summary: suitable ? evaluation.summary : null,
        score: suitable ? evaluation.score : null,
        fitLabel: suitable ? evaluation.fitLabel : null,
        decisionReason: suitable ? evaluation.decisionReason : null,
        fitBreakdownJson: suitable && evaluation.fitBreakdown
          ? JSON.stringify(evaluation.fitBreakdown)
          : null,
        suitable: suitable ? 1 : 0,
        applyUrl: suitable ? evaluation.applyUrl : existing.canonical_url,
        sources: suitable ? existing.sources_json : '[]',
        jobKey,
      });
    },

    listUnpresentedSuitable() {
      return db.prepare(`
        SELECT
          job_key AS jobKey,
          company,
          title,
          summary,
          score,
          fit_label AS fitLabel,
          decision_reason AS decisionReason,
          apply_url AS applyUrl
        FROM jobs
        WHERE archived_at IS NULL
          AND suitable = 1 AND presented_at IS NULL AND active_status = 'active'
        ORDER BY score DESC, first_seen_at ASC
      `).all();
    },

    listUnopenedSuitable() {
      return db.prepare(`
        SELECT job_key AS jobKey, company, title, apply_url AS applyUrl
        FROM jobs
        WHERE archived_at IS NULL
          AND suitable = 1 AND opened_at IS NULL AND active_status = 'active'
        ORDER BY score DESC, first_seen_at ASC
      `).all();
    },

    markPresented(jobKeys, at = Date.now()) {
      const update = db.prepare('UPDATE jobs SET presented_at = ? WHERE job_key = ?');
      db.transaction((keys) => keys.forEach((key) => update.run(at, key)))(jobKeys);
    },

    markOpened(jobKeys, at = Date.now()) {
      const update = db.prepare('UPDATE jobs SET opened_at = ? WHERE job_key = ?');
      db.transaction((keys) => keys.forEach((key) => update.run(at, key)))(jobKeys);
    },

    archiveJob(jobKey, at = Date.now()) {
      const result = db.prepare(`
        UPDATE jobs SET
          company = NULL,
          title = NULL,
          summary = NULL,
          score = NULL,
          fit_label = NULL,
          decision_reason = NULL,
          fit_breakdown_json = NULL,
          suitable = 0,
          active_status = 'archived',
          apply_url = canonical_url,
          sources_json = '[]',
          content_hash = NULL,
          profile_hash = NULL,
          criteria_version = NULL,
          evaluated_at = NULL,
          presented_at = NULL,
          opened_at = NULL,
          archived_at = ?
        WHERE job_key = ? AND archived_at IS NULL
      `).run(at, jobKey);
      return result.changes === 1;
    },

    getFreshPage(canonicalUrl, { now = Date.now(), ttlMs }) {
      const row = db.prepare('SELECT * FROM job_pages WHERE canonical_url = ?').get(canonicalUrl);
      if (!row || now - row.fetched_at > ttlMs) return null;
      return row;
    },

    savePage({ canonicalUrl, finalUrl, status, content, contentHash, fetchedAt = Date.now() }) {
      db.prepare(`
        INSERT INTO job_pages (canonical_url, final_url, status, content, content_hash, fetched_at)
        VALUES (@canonicalUrl, @finalUrl, @status, @content, @contentHash, @fetchedAt)
        ON CONFLICT(canonical_url) DO UPDATE SET
          final_url = excluded.final_url,
          status = excluded.status,
          content = excluded.content,
          content_hash = excluded.content_hash,
          fetched_at = excluded.fetched_at
      `).run({ canonicalUrl, finalUrl, status, content, contentHash, fetchedAt });
    },

    shouldProcessMessage(messageId) {
      const row = db.prepare('SELECT status FROM processed_messages WHERE message_id = ?').get(messageId);
      return !row || row.status !== 'done';
    },

    queueWhatsAppMessage({ messageId, groupJid, timestamp, text }) {
      const result = db.prepare(`
        INSERT INTO processed_messages (
          message_id, group_jid, wa_timestamp, message_text, status, retry_count, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          group_jid = excluded.group_jid,
          wa_timestamp = excluded.wa_timestamp,
          message_text = excluded.message_text,
          status = 'pending',
          last_error = NULL,
          updated_at = excluded.updated_at
        WHERE processed_messages.status <> 'done'
          AND processed_messages.message_text IS NULL
      `).run(messageId, groupJid, timestamp, text, Date.now());
      return result.changes === 1;
    },

    listPendingWhatsAppMessages(groupJid, { untilMs = Date.now(), limit = 2_000 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 2_000, 5_000));
      return db.prepare(`
        SELECT
          message_id AS messageId,
          group_jid AS groupJid,
          wa_timestamp AS timestamp,
          message_text AS text
        FROM processed_messages
        WHERE group_jid = ?
          AND status IN ('pending', 'failed')
          AND message_text IS NOT NULL
          AND wa_timestamp <= ?
        ORDER BY wa_timestamp ASC
        LIMIT ?
      `).all(groupJid, untilMs, boundedLimit);
    },

    getMessageState(messageId) {
      const row = db.prepare(`
        SELECT status, message_text IS NOT NULL AS has_text
        FROM processed_messages
        WHERE message_id = ?
      `).get(messageId);
      return row ? { status: row.status, hasText: Boolean(row.has_text) } : null;
    },

    markMessageDone({ messageId, groupJid, timestamp = null }) {
      db.prepare(`
        INSERT INTO processed_messages (message_id, group_jid, wa_timestamp, message_text, status, updated_at)
        VALUES (?, ?, ?, NULL, 'done', ?)
        ON CONFLICT(message_id) DO UPDATE SET
          status = 'done', wa_timestamp = excluded.wa_timestamp,
          message_text = NULL, last_error = NULL, updated_at = excluded.updated_at
      `).run(messageId, groupJid, timestamp, Date.now());
    },

    markMessageFailed({ messageId, groupJid, error }) {
      db.prepare(`
        INSERT INTO processed_messages (
          message_id, group_jid, status, retry_count, last_error, updated_at
        ) VALUES (?, ?, 'failed', 1, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          status = 'failed', retry_count = processed_messages.retry_count + 1,
          last_error = excluded.last_error, updated_at = excluded.updated_at
      `).run(messageId, groupJid, String(error ?? '').slice(0, 500), Date.now());
    },

    getCheckpoint(sourceKey) {
      return db.prepare('SELECT last_timestamp FROM checkpoints WHERE source_key = ?').get(sourceKey)?.last_timestamp ?? null;
    },

    setCheckpoint(sourceKey, timestamp) {
      db.prepare(`
        INSERT INTO checkpoints (source_key, last_timestamp) VALUES (?, ?)
        ON CONFLICT(source_key) DO UPDATE SET last_timestamp = excluded.last_timestamp
        WHERE excluded.last_timestamp > checkpoints.last_timestamp
      `).run(sourceKey, timestamp);
    },

    importWhatsAppState({ messages = [], checkpoints = [] }) {
      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO processed_messages (
          message_id, group_jid, wa_timestamp, status, retry_count, updated_at
        ) VALUES (@messageId, @groupJid, @timestamp, 'done', 0, @updatedAt)
      `);
      const importMessages = db.transaction((rows) => {
        let imported = 0;
        for (const row of rows) {
          if (!row.message_id || !row.group_jid) continue;
          imported += insertMessage.run({
            messageId: row.message_id,
            groupJid: row.group_jid,
            timestamp: Number(row.wa_timestamp) || null,
            updatedAt: Number(row.processed_at) || Date.now(),
          }).changes;
        }
        return imported;
      });
      const messagesImported = importMessages(messages);

      for (const checkpoint of checkpoints) {
        if (!checkpoint.group_jid) continue;
        this.setCheckpoint(
          `whatsapp:${checkpoint.group_jid}`,
          Number(checkpoint.last_wa_timestamp) || 0,
        );
      }
      return { messagesImported, checkpointsSeen: checkpoints.length };
    },

    startRun({ fromTs, toTs, sources, startedAt = Date.now() }) {
      return db.prepare(`
        INSERT INTO runs (started_at, from_ts, to_ts, sources, status)
        VALUES (?, ?, ?, ?, 'running')
      `).run(startedAt, fromTs, toTs, JSON.stringify(sources)).lastInsertRowid;
    },

    finishRun(runId, { status, error = null, details = null, finishedAt = Date.now() }) {
      db.prepare('UPDATE runs SET finished_at = ?, status = ?, error = ?, details_json = ? WHERE id = ?')
        .run(finishedAt, status, error, details ? JSON.stringify(details) : null, runId);
    },

    getLastRun() {
      const row = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
      if (!row) return null;
      const { details_json: detailsJson, ...run } = row;
      return { ...run, details: parseJson(detailsJson) };
    },

    getLastSuccessfulRun(requiredSources = []) {
      const rows = db.prepare(`
        SELECT * FROM runs WHERE status = 'success' ORDER BY finished_at DESC
      `).all();
      return rows.find((row) => {
        const completedSources = new Set(parseSources(row.sources));
        return requiredSources.every((source) => completedSources.has(source));
      }) ?? null;
    },

    close() {
      db.close();
    },
  };
}
