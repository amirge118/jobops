import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { canonicalizeJobUrl, normalizeCompanyRole } from './core.mjs';
import {
  COMPANY_STATUSES,
  CompanyRegistryError,
  companySourceKey,
  companySourcePortalFields,
  normalizeCompanyCandidate,
  normalizeCompanyIdentity,
  normalizeCompanySource,
  resolveCompanyCandidate,
} from './company-registry.mjs';
import { describeFailure, observedRun, processState } from './diagnostics.mjs';
import { normalizeWhatsAppAnchor } from './sources/whatsapp-history.mjs';

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

function requiredAuditField(value, name, maxLength = 64) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function serializeAuditDetails(details) {
  if (details == null) return null;
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
    throw new Error('run event details exceed 16KB');
  }
  return serialized;
}

function companyId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new CompanyRegistryError('invalid_company_id', 'Company id must be a positive integer');
  }
  return id;
}

function mapCompanySource(row) {
  if (!row) return null;
  const config = parseJson(row.source_config_json, {});
  const source = {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    boardKey: row.board_key,
    careersUrl: row.careers_url,
    apiUrl: row.api_url,
    enabled: Boolean(row.enabled),
    health: row.health,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    verificationStatus: row.verification_status || 'unverified',
    lastJobCount: row.last_job_count == null ? null : Number(row.last_job_count),
    lastErrorReason: row.last_error_reason || null,
    lastProbeAt: row.last_probe_at == null ? null : Number(row.last_probe_at),
    discoveryEvidence: parseJson(row.discovery_evidence_json, []),
  };
  return config && Object.keys(config).length ? { ...source, config } : source;
}

function mapCompany(row, sources = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    canonicalDomain: row.canonical_domain,
    status: row.status,
    discoverySource: row.discovery_source,
    resolutionStatus: row.resolution_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sources,
  };
}

function mapWhatsAppHistoryGroup(row) {
  return {
    name: row.group_name,
    status: row.status,
    requestedFrom: row.requested_from == null ? null : Number(row.requested_from),
    delivered: Number(row.delivered || 0),
    queued: Number(row.queued || 0),
    duplicates: Number(row.duplicates || 0),
    ignored: Number(row.ignored || 0),
    rejected: Number(row.rejected || 0),
    oldestAt: row.oldest_at,
    newestAt: row.newest_at,
    batches: Number(row.batches || 0),
    reason: row.reason,
  };
}

function mapWhatsAppHistoryRequest(row, groups = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    fromTs: Number(row.from_ts),
    toTs: Number(row.to_ts),
    status: row.status,
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    ownerPid: row.owner_pid == null ? null : Number(row.owner_pid),
    currentGroup: row.current_group,
    groupsTotal: Number(row.groups_total || 0),
    groupsCompleted: Number(row.groups_completed || 0),
    messagesReceived: Number(row.messages_received || 0),
    messagesQueued: Number(row.messages_queued || 0),
    duplicates: Number(row.duplicates || 0),
    ignored: Number(row.ignored || 0),
    rejected: Number(row.rejected || 0),
    failure: parseJson(row.diagnostic_json),
    groups,
  };
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
      archived_at      INTEGER,
      last_error_code  TEXT,
      last_error_reason TEXT,
      last_attempted_at INTEGER
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

    CREATE TABLE IF NOT EXISTS run_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      INTEGER NOT NULL,
      source      TEXT NOT NULL,
      scope       TEXT NOT NULL,
      scope_key   TEXT,
      stage       TEXT NOT NULL,
      status      TEXT NOT NULL,
      item_count  INTEGER,
      details_json TEXT,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, id);

    CREATE TABLE IF NOT EXISTS action_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      owner_pid INTEGER,
      child_pid INTEGER,
      diagnostic_json TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS collector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      owner_pid INTEGER,
      heartbeat_at INTEGER,
      stage TEXT,
      connected_at INTEGER,
      last_message_at INTEGER,
      messages_received INTEGER NOT NULL DEFAULT 0,
      messages_queued INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      receipts_sent INTEGER NOT NULL DEFAULT 0,
      reconnects INTEGER NOT NULL DEFAULT 0,
      groups_found INTEGER,
      groups_expected INTEGER,
      diagnostic_json TEXT
    );

    CREATE TABLE IF NOT EXISTS collector_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collector_run_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      item_count INTEGER,
      details_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (collector_run_id) REFERENCES collector_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS collector_events_run_idx
      ON collector_events(collector_run_id, id);

    CREATE TABLE IF NOT EXISTS whatsapp_anchors (
      group_jid TEXT PRIMARY KEY,
      message_key_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_history_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('pending', 'running', 'complete', 'partial', 'failed')),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      owner_pid INTEGER,
      current_group TEXT,
      groups_total INTEGER NOT NULL DEFAULT 0,
      groups_completed INTEGER NOT NULL DEFAULT 0,
      messages_received INTEGER NOT NULL DEFAULT 0,
      messages_queued INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      diagnostic_json TEXT
    );

    CREATE INDEX IF NOT EXISTS whatsapp_history_requests_status_idx
      ON whatsapp_history_requests(status, created_at);

    CREATE TABLE IF NOT EXISTS whatsapp_history_groups (
      request_id INTEGER NOT NULL,
      group_name TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_from INTEGER,
      delivered INTEGER NOT NULL DEFAULT 0,
      queued INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      oldest_at INTEGER,
      newest_at INTEGER,
      batches INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(request_id, group_name),
      FOREIGN KEY(request_id) REFERENCES whatsapp_history_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      canonical_domain TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'candidate'
        CHECK(status IN ('candidate', 'watched', 'paused', 'ignored')),
      discovery_source TEXT NOT NULL,
      resolution_status TEXT NOT NULL DEFAULT 'unsupported'
        CHECK(resolution_status IN ('resolved', 'unsupported')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS company_job_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL
        CHECK(provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'comeet', 'official-html', 'workday', 'zoho-recruit', 'teamme', 'unsupported')),
      board_key TEXT,
      careers_url TEXT NOT NULL,
      api_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'unknown'
        CHECK(health IN ('unknown', 'healthy', 'failed')),
      last_checked_at INTEGER,
      last_success_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS company_job_sources_company_idx
      ON company_job_sources(company_id, enabled);
  `);

  let companySourceColumns = db.prepare('PRAGMA table_info(company_job_sources)').all();
  const companySourceAdditions = {
    verification_status: "TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified', 'verified_jobs', 'verified_empty', 'blocked', 'failed', 'needs_adapter', 'external_only', 'stale'))",
    last_job_count: 'INTEGER',
    last_error_reason: 'TEXT',
    last_probe_at: 'INTEGER',
    discovery_evidence_json: 'TEXT',
    source_config_json: 'TEXT',
  };
  for (const [name, definition] of Object.entries(companySourceAdditions)) {
    if (!companySourceColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE company_job_sources ADD COLUMN ${name} ${definition}`);
    }
  }
  const companySourcesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'company_job_sources'").get()?.sql || '';
  if (!['comeet', 'official-html', 'workday', 'zoho-recruit', 'teamme'].every((provider) => companySourcesSql.includes(`'${provider}'`))) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE company_job_sources RENAME TO company_job_sources_legacy;
        CREATE TABLE company_job_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          source_key TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL
            CHECK(provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'comeet', 'official-html', 'workday', 'zoho-recruit', 'teamme', 'unsupported')),
          board_key TEXT,
          careers_url TEXT NOT NULL,
          api_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          health TEXT NOT NULL DEFAULT 'unknown'
            CHECK(health IN ('unknown', 'healthy', 'failed')),
          last_checked_at INTEGER,
          last_success_at INTEGER,
          last_error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'unverified'
            CHECK(verification_status IN ('unverified', 'verified_jobs', 'verified_empty', 'blocked', 'failed', 'needs_adapter', 'external_only', 'stale')),
          last_job_count INTEGER,
          last_error_reason TEXT,
          last_probe_at INTEGER,
          discovery_evidence_json TEXT,
          source_config_json TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
        );
        INSERT INTO company_job_sources (
          id, company_id, source_key, provider, board_key, careers_url, api_url,
          enabled, health, last_checked_at, last_success_at, last_error_code, created_at, updated_at,
          verification_status, last_job_count, last_error_reason, last_probe_at,
          discovery_evidence_json, source_config_json
        ) SELECT
          id, company_id, source_key, provider, board_key, careers_url, api_url,
          enabled, health, last_checked_at, last_success_at, last_error_code, created_at, updated_at,
          verification_status, last_job_count, last_error_reason, last_probe_at,
          discovery_evidence_json, source_config_json
        FROM company_job_sources_legacy;
        DROP TABLE company_job_sources_legacy;
        CREATE INDEX company_job_sources_company_idx
          ON company_job_sources(company_id, enabled);
      `);
    })();
  }

  const runColumns = db.prepare('PRAGMA table_info(runs)').all();
  if (!runColumns.some((column) => column.name === 'details_json')) {
    db.exec('ALTER TABLE runs ADD COLUMN details_json TEXT');
  }
  for (const [name, type] of Object.entries({ owner_pid: 'INTEGER', heartbeat_at: 'INTEGER', stage: 'TEXT', action_id: 'INTEGER', diagnostic_json: 'TEXT' })) {
    if (!runColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }

  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all();
  if (!jobColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }
  if (!jobColumns.some((column) => column.name === 'fit_breakdown_json')) {
    db.exec('ALTER TABLE jobs ADD COLUMN fit_breakdown_json TEXT');
  }
  if (!jobColumns.some((column) => column.name === 'last_error_code')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_error_code TEXT');
  }
  if (!jobColumns.some((column) => column.name === 'last_error_reason')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_error_reason TEXT');
  }
  if (!jobColumns.some((column) => column.name === 'last_attempted_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_attempted_at INTEGER');
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
  const whatsappHistoryGroupColumns = db.prepare('PRAGMA table_info(whatsapp_history_groups)').all();
  if (!whatsappHistoryGroupColumns.some((column) => column.name === 'requested_from')) {
    db.exec('ALTER TABLE whatsapp_history_groups ADD COLUMN requested_from INTEGER');
  }

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

  // A rejected role retains only job identity and evaluation hashes for dedup.
  // Full fetched page text is unnecessary once the decision is final.
  db.exec(`
    DELETE FROM job_pages
    WHERE canonical_url IN (
      SELECT canonical_url FROM jobs
      WHERE suitable = 0 AND evaluated_at IS NOT NULL
    )
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

  const getCompanyRow = db.prepare('SELECT * FROM companies WHERE id = ?');
  const listCompanySources = db.prepare('SELECT * FROM company_job_sources WHERE company_id = ? ORDER BY id');
  const getCompanySnapshot = (id) => {
    const row = getCompanyRow.get(id);
    return row ? mapCompany(row, listCompanySources.all(id).map(mapCompanySource)) : null;
  };

  const findCompanyForCandidate = db.prepare(`
    SELECT c.*
    FROM companies c
    LEFT JOIN company_job_sources s ON s.company_id = c.id
    WHERE (@sourceKey IS NOT NULL AND s.source_key = @sourceKey)
       OR (@canonicalDomain IS NOT NULL AND c.canonical_domain = @canonicalDomain)
       OR c.normalized_name = @normalizedName
    ORDER BY
      CASE WHEN @sourceKey IS NOT NULL AND s.source_key = @sourceKey THEN 0 ELSE 1 END,
      CASE WHEN @canonicalDomain IS NOT NULL AND c.canonical_domain = @canonicalDomain THEN 0 ELSE 1 END,
      c.id
    LIMIT 1
  `);
  const findCompanyForSourceKey = db.prepare(`
    SELECT c.*
    FROM companies c
    JOIN company_job_sources s ON s.company_id = c.id
    WHERE s.source_key = ?
    LIMIT 1
  `);

  const saveCompanySource = (targetCompanyId, input, at = Date.now()) => {
    const id = companyId(targetCompanyId);
    if (!getCompanyRow.get(id)) throw new CompanyRegistryError('company_not_found', 'Company was not found');
    const source = normalizeCompanySource(input);
    const sourceKey = companySourceKey(source);
    const existing = db.prepare('SELECT * FROM company_job_sources WHERE source_key = ?').get(sourceKey);
    if (existing && existing.company_id !== id) {
      throw new CompanyRegistryError('source_conflict', 'ATS source is already assigned to another company');
    }
    db.prepare(`
      INSERT INTO company_job_sources (
        company_id, source_key, provider, board_key, careers_url, api_url,
        source_config_json, enabled, health, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        careers_url = excluded.careers_url,
        api_url = excluded.api_url,
        source_config_json = excluded.source_config_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
      WHERE company_job_sources.company_id = excluded.company_id
    `).run(
      id,
      sourceKey,
      source.provider,
      source.boardKey,
      source.careersUrl,
      source.apiUrl,
      JSON.stringify(source.config || {}),
      source.enabled ? 1 : 0,
      Number(at),
      Number(at),
    );
    return mapCompanySource(db.prepare('SELECT * FROM company_job_sources WHERE source_key = ?').get(sourceKey));
  };

  return {
    getCompanyStats() {
      const counts = Object.fromEntries(COMPANY_STATUSES.map((status) => [status, 0]));
      for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM companies GROUP BY status').all()) {
        if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count);
      }
      return counts;
    },

    listCompanies({ status = null, limit = 500 } = {}) {
      if (status != null && !COMPANY_STATUSES.includes(status)) {
        throw new CompanyRegistryError('invalid_company_status', 'Company status is invalid');
      }
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 1_000));
      const rows = status == null
        ? db.prepare('SELECT * FROM companies ORDER BY updated_at DESC, id DESC LIMIT ?').all(boundedLimit)
        : db.prepare('SELECT * FROM companies WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(status, boundedLimit);
      if (!rows.length) return [];
      const wanted = new Set(rows.map((row) => row.id));
      const sourcesByCompany = new Map(rows.map((row) => [row.id, []]));
      for (const source of db.prepare('SELECT * FROM company_job_sources ORDER BY id').all()) {
        if (wanted.has(source.company_id)) sourcesByCompany.get(source.company_id).push(mapCompanySource(source));
      }
      return rows.map((row) => mapCompany(row, sourcesByCompany.get(row.id)));
    },

    getCompany(id) {
      return getCompanySnapshot(companyId(id));
    },

    upsertCompanyCandidate(input, at = Date.now()) {
      const candidate = normalizeCompanyCandidate(input);
      const normalizedName = normalizeCompanyIdentity(candidate.name);
      const sourceKey = candidate.source ? companySourceKey(candidate.source) : null;
      let row = findCompanyForCandidate.get({
        sourceKey,
        canonicalDomain: candidate.canonicalDomain,
        normalizedName,
      });
      const save = db.transaction(() => {
        if (!row) {
          const result = db.prepare(`
            INSERT INTO companies (
              name, normalized_name, canonical_domain, status, discovery_source,
              resolution_status, created_at, updated_at
            ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)
          `).run(
            candidate.name,
            normalizedName,
            candidate.canonicalDomain,
            candidate.discoverySource,
            candidate.resolutionStatus,
            Number(at),
            Number(at),
          );
          row = getCompanyRow.get(result.lastInsertRowid);
        } else {
          db.prepare(`
            UPDATE companies SET
              canonical_domain = COALESCE(canonical_domain, ?),
              resolution_status = CASE WHEN ? = 'resolved' THEN 'resolved' ELSE resolution_status END,
              updated_at = ?
            WHERE id = ?
          `).run(candidate.canonicalDomain, candidate.resolutionStatus, Number(at), row.id);
        }
        if (candidate.source) {
          saveCompanySource(row.id, candidate.source, at);
          if (candidate.source.provider !== 'unsupported') {
            db.prepare(`
              DELETE FROM company_job_sources
              WHERE company_id = ? AND provider = 'unsupported'
            `).run(row.id);
          }
        }
        return getCompanySnapshot(row.id);
      });
      const company = save();
      return { company, sources: company.sources };
    },

    upsertCompanySource(id, input, at = Date.now()) {
      return saveCompanySource(id, input, at);
    },

    resolveCompanyCandidateForJob(jobKey) {
      const job = db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(String(jobKey ?? ''));
      if (!job) throw new CompanyRegistryError('job_not_found', 'Job was not found');
      if (!job.suitable || job.archived_at != null || job.active_status !== 'active') {
        throw new CompanyRegistryError('job_not_suitable', 'Only an active suitable job can resolve a company');
      }
      const sources = parseSources(job.sources_json);
      const discoverySource = sources.some((source) => /^whatsapp:/i.test(source)) ? 'whatsapp' : 'ats';
      return {
        jobKey: job.job_key,
        ...resolveCompanyCandidate({
          company: job.company,
          // The evaluator stores the final posting URL in apply_url after following
          // WhatsApp shorteners; canonical_url may still be the redirect URL.
          jobUrl: job.apply_url,
          discoverySource,
        }),
      };
    },

    approveCompany(id, at = Date.now()) {
      const normalizedId = companyId(id);
      const row = getCompanyRow.get(normalizedId);
      if (!row) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      const supported = db.prepare(`
        SELECT 1 FROM company_job_sources
        WHERE company_id = ? AND enabled = 1 AND provider <> 'unsupported'
        LIMIT 1
      `).get(normalizedId);
      if (!supported) {
        throw new CompanyRegistryError('company_not_scannable', 'Company does not have a supported ATS source');
      }
      db.prepare("UPDATE companies SET status = 'watched', updated_at = ? WHERE id = ?")
        .run(Number(at), normalizedId);
      return true;
    },

    setCompanyStatus(id, status, at = Date.now()) {
      const normalizedId = companyId(id);
      if (status === 'watched') {
        throw new CompanyRegistryError('approval_required', 'Use approveCompany() to start watching a company');
      }
      if (!COMPANY_STATUSES.includes(status)) {
        throw new CompanyRegistryError('invalid_company_status', 'Company status is invalid');
      }
      const result = db.prepare('UPDATE companies SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Number(at), normalizedId);
      if (!result.changes) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      return true;
    },

    importConfiguredCompanies(entries, at = Date.now()) {
      if (!Array.isArray(entries)) throw new CompanyRegistryError('invalid_import', 'Configured companies must be an array');
      if (entries.length > 2_000) throw new CompanyRegistryError('import_too_large', 'Configured company import exceeds 2000 entries');
      let imported = 0;
      let skipped = 0;
      for (const entry of entries) {
        try {
          const candidate = resolveCompanyCandidate({
            company: entry?.name,
            jobUrl: entry?.careers_url,
            discoverySource: 'configured',
          });
          if (entry?.provider || entry?.api) {
            candidate.source = normalizeCompanySource({
              careersUrl: entry.careers_url,
              provider: entry.provider,
              api: entry.api,
              config: entry,
              enabled: entry.enabled !== false,
            });
            candidate.resolutionStatus = candidate.source.provider === 'unsupported' ? 'unsupported' : 'resolved';
          } else {
            candidate.source = normalizeCompanySource({
              ...candidate.source,
              config: entry,
              enabled: candidate.source.provider !== 'unsupported' && entry?.enabled !== false,
            });
          }
          const existingSourceKey = candidate.source ? companySourceKey(candidate.source) : null;
          const normalizedName = normalizeCompanyIdentity(candidate.name);

          if (candidate.canonicalDomain == null && candidate.source) {
            const namedOwner = db.prepare('SELECT * FROM companies WHERE normalized_name = ?').get(normalizedName);
            if (namedOwner?.discovery_source === 'configured') {
              db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                .run(Number(at), namedOwner.id);
              db.prepare(`
                DELETE FROM company_job_sources
                WHERE company_id = ? AND provider = 'unsupported' AND careers_url = ? AND source_key <> ?
              `).run(namedOwner.id, candidate.source.careersUrl, existingSourceKey);
            }
            const legacyUrlOwner = db.prepare(`
              SELECT c.* FROM companies c
              JOIN company_job_sources s ON s.company_id = c.id
              WHERE s.careers_url = ? AND s.provider = 'unsupported'
              LIMIT 1
            `).get(candidate.source.careersUrl);
            if (legacyUrlOwner?.discovery_source === 'configured' && legacyUrlOwner.normalized_name !== normalizedName) {
              db.prepare('DELETE FROM company_job_sources WHERE company_id = ? AND careers_url = ? AND provider = ?')
                .run(legacyUrlOwner.id, candidate.source.careersUrl, 'unsupported');
              db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                .run(Number(at), legacyUrlOwner.id);
            }
          }

          // Versions before 2026-09-10 treated a shared unsupported recruiting
          // host (notably comeet.com) as the company's canonical domain. That
          // could attach several configured companies' distinct board URLs to
          // the first imported company. The configured catalogue is exact enough
          // to repair only those stale configured-owned associations while still
          // preserving user status choices on each company.
          if (candidate.canonicalDomain == null && existingSourceKey) {
            const sourceOwner = findCompanyForSourceKey.get(existingSourceKey);
            if (sourceOwner?.discovery_source === 'configured') {
              if (sourceOwner.canonical_domain) {
                db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                  .run(Number(at), sourceOwner.id);
              }
              if (sourceOwner.normalized_name !== normalizedName) {
                db.prepare('DELETE FROM company_job_sources WHERE source_key = ?').run(existingSourceKey);
              }
            }
          }

          const preexisting = findCompanyForCandidate.get({
            sourceKey: existingSourceKey,
            canonicalDomain: candidate.canonicalDomain,
            normalizedName,
          });
          const saved = this.upsertCompanyCandidate(candidate, at);
          const autoPausedUnsupportedUpgrade = preexisting?.status === 'paused' &&
            preexisting?.resolution_status === 'unsupported' &&
            preexisting?.discovery_source === 'configured';
          if (!preexisting || autoPausedUnsupportedUpgrade) {
            if (candidate.source?.enabled && entry?.enabled !== false) this.approveCompany(saved.company.id, at);
            else this.setCompanyStatus(saved.company.id, 'paused', at);
          }
          imported += 1;
        } catch (error) {
          if (!(error instanceof CompanyRegistryError)) throw error;
          skipped += 1;
        }
      }
      return { imported, skipped };
    },

    listWatchedCompanySources() {
      return db.prepare(`
        SELECT
          c.name,
          s.careers_url,
          s.provider,
          s.api_url,
          s.source_config_json,
          s.id AS source_id
        FROM company_job_sources s
        JOIN companies c ON c.id = s.company_id
        WHERE c.status = 'watched'
          AND s.enabled = 1
          AND s.provider <> 'unsupported'
        ORDER BY c.name COLLATE NOCASE, s.id
      `).all().map((row) => {
        const source = normalizeCompanySource({
          provider: row.provider, careersUrl: row.careers_url,
          apiUrl: row.api_url, config: parseJson(row.source_config_json, {}), enabled: true,
        });
        return {
          name: row.name,
          careers_url: source.careersUrl,
          provider: source.provider,
          ...(source.apiUrl ? { api: source.apiUrl } : {}),
          ...companySourcePortalFields(source),
          enabled: true,
          sourceId: row.source_id,
        };
      });
    },

    updateCompanySourceHealth(sourceId, { status, errorCode = null, at = Date.now() } = {}) {
      const id = Number(sourceId);
      if (!Number.isInteger(id) || id < 1) throw new CompanyRegistryError('invalid_source_id', 'Source id must be a positive integer');
      if (!['unknown', 'healthy', 'failed'].includes(status)) {
        throw new CompanyRegistryError('invalid_source_health', 'Company source health is invalid');
      }
      let safeErrorCode = null;
      if (status === 'failed') {
        safeErrorCode = String(errorCode || 'scan_failed').trim().toLowerCase();
        if (!/^[a-z0-9_:-]{1,64}$/.test(safeErrorCode)) {
          throw new CompanyRegistryError('invalid_error_code', 'Company source error code is invalid');
        }
      }
      const result = db.prepare(`
        UPDATE company_job_sources SET
          health = ?,
          last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          last_error_code = ?,
          updated_at = ?
        WHERE id = ?
      `).run(status, Number(at), status, Number(at), safeErrorCode, Number(at), id);
      if (!result.changes) throw new CompanyRegistryError('source_not_found', 'Company source was not found');
      return true;
    },

    recordCompanySourceProbe(sourceId, probe, evidenceUrls = [], at = Date.now()) {
      const id = Number(sourceId);
      if (!Number.isInteger(id) || id < 1) throw new CompanyRegistryError('invalid_source_id', 'Source id must be a positive integer');
      const status = String(probe?.status || '');
      const allowed = ['verified_jobs', 'verified_empty', 'blocked', 'failed', 'needs_adapter', 'external_only', 'stale'];
      if (!allowed.includes(status)) throw new CompanyRegistryError('invalid_probe_status', 'Company source probe status is invalid');
      const count = Number(probe?.count ?? 0);
      if (!Number.isInteger(count) || count < 0 || count > 5_000) {
        throw new CompanyRegistryError('invalid_probe_count', 'Company source probe count is invalid');
      }
      const errorCode = probe?.errorCode == null ? null : String(probe.errorCode).trim().toLowerCase();
      if (errorCode && !/^[a-z0-9_:-]{1,64}$/.test(errorCode)) {
        throw new CompanyRegistryError('invalid_error_code', 'Company source error code is invalid');
      }
      const reason = String(probe?.reason || '').replace(/[\r\n\t\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
      if (!Array.isArray(evidenceUrls) || evidenceUrls.length > 3) {
        throw new CompanyRegistryError('invalid_evidence', 'Company source evidence must contain at most three URLs');
      }
      const evidence = evidenceUrls.map((value) => String(value).slice(0, 2_048));
      const health = ['verified_jobs', 'verified_empty'].includes(status) ? 'healthy'
        : ['blocked', 'failed', 'stale'].includes(status) ? 'failed' : 'unknown';
      const result = db.prepare(`
        UPDATE company_job_sources SET
          verification_status = ?, last_job_count = ?, last_error_reason = ?,
          last_error_code = ?, last_probe_at = ?, discovery_evidence_json = ?,
          health = ?, last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          updated_at = ?
        WHERE id = ?
      `).run(
        status, count, reason, errorCode, Number(at), JSON.stringify(evidence),
        health, Number(at), health, Number(at), Number(at), id,
      );
      if (!result.changes) throw new CompanyRegistryError('source_not_found', 'Company source was not found');
      return true;
    },

    recordCompanyScanResults({ scannedNames = [], errorNames = [], at = Date.now() } = {}) {
      if (!Array.isArray(scannedNames) || !Array.isArray(errorNames) || scannedNames.length + errorNames.length > 10_000) {
        throw new CompanyRegistryError('invalid_scan_results', 'Company scan result list is invalid');
      }
      const errors = new Set(errorNames.map(normalizeCompanyIdentity));
      const scanned = new Set(scannedNames.map(normalizeCompanyIdentity));
      let updated = 0;
      const updateByName = db.prepare(`
        UPDATE company_job_sources SET
          health = ?, last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          last_error_code = ?, updated_at = ?
        WHERE company_id IN (SELECT id FROM companies WHERE normalized_name = ?)
      `);
      const apply = db.transaction(() => {
        for (const name of scanned) {
          if (errors.has(name)) continue;
          updated += updateByName.run('healthy', Number(at), 'healthy', Number(at), null, Number(at), name).changes;
        }
        for (const name of errors) {
          updated += updateByName.run('failed', Number(at), 'failed', Number(at), 'scan_failed', Number(at), name).changes;
        }
      });
      apply();
      return { updated };
    },

    recordSighting({ url, company = '', title = '', source, seenAt = Date.now() }) {
      const canonicalUrl = canonicalizeJobUrl(url);
      if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);
      const companyRoleKey = normalizeCompanyRole(company, title);
      const existing = findByIdentity.get({ canonicalUrl, companyRoleKey });

      if (existing) {
        if (existing.archived_at || (existing.evaluated_at && !existing.suitable)) {
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

    listPendingEvaluation({ limit = 5_000 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 5_000, 10_000));
      return db.prepare(`
        SELECT
          job_key AS jobKey,
          canonical_url AS canonicalUrl,
          apply_url AS url,
          company,
          title,
          sources_json AS sourcesJson
        FROM jobs
        WHERE archived_at IS NULL
          AND (evaluated_at IS NULL OR last_error_code IS NOT NULL)
        ORDER BY first_seen_at ASC
        LIMIT ?
      `).all(boundedLimit).map(({ sourcesJson, ...job }) => ({
        ...job,
        source: parseSources(sourcesJson)[0] || 'retry',
      }));
    },

    getDashboardStats() {
      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' THEN 1 ELSE 0 END) AS suitable,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' AND opened_at IS NULL THEN 1 ELSE 0 END) AS unopened
        FROM jobs
      `).get();
      return {
        total: Number(stats.total || 0),
        suitable: Number(stats.suitable || 0),
        unopened: Number(stats.unopened || 0),
      };
    },

    listDashboardJobs() {
      return db.prepare(`
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
    },

    getDashboardSnapshot() {
      return {
        stats: this.getDashboardStats(),
        jobs: this.listDashboardJobs(),
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

    markEvaluationFailure(jobKey, { code, reason, attemptedAt = Date.now() }) {
      const safeCode = String(code || 'unknown_failure').trim();
      if (!/^[a-z0-9_:-]{1,64}$/i.test(safeCode)) throw new Error('Invalid evaluation failure code');
      const safeReason = String(reason || 'Unknown evaluation failure')
        .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const result = db.prepare(`
        UPDATE jobs SET
          last_error_code = ?,
          last_error_reason = ?,
          last_attempted_at = ?
        WHERE job_key = ? AND archived_at IS NULL
      `).run(safeCode, safeReason, attemptedAt, jobKey);
      if (result.changes !== 1) throw new Error(`Cannot record evaluation failure for job: ${jobKey}`);
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
          sources_json = @sources,
          last_error_code = NULL,
          last_error_reason = NULL,
          last_attempted_at = @evaluatedAt
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
      if (!suitable) {
        db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(existing.canonical_url);
      }
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
          last_error_code = NULL,
          last_error_reason = NULL,
          last_attempted_at = NULL,
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

    discardPage(canonicalUrl) {
      db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(canonicalUrl);
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

    saveWhatsAppAnchor(groupJid, message) {
      const anchor = normalizeWhatsAppAnchor(message, groupJid);
      if (!anchor) return false;
      return db.prepare(`INSERT INTO whatsapp_anchors (group_jid, message_key_json, timestamp) VALUES (?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET message_key_json = excluded.message_key_json, timestamp = excluded.timestamp
        WHERE excluded.timestamp >= whatsapp_anchors.timestamp`)
        .run(groupJid, JSON.stringify(anchor.key), anchor.messageTimestamp).changes > 0;
    },

    getWhatsAppAnchor(groupJid) {
      const row = db.prepare('SELECT message_key_json, timestamp FROM whatsapp_anchors WHERE group_jid = ?').get(groupJid);
      return row ? normalizeWhatsAppAnchor({ key: parseJson(row.message_key_json), messageTimestamp: row.timestamp }, groupJid) : null;
    },

    listPendingWhatsAppMessages(groupJid, { sinceMs = 0, untilMs = Date.now(), limit = 2_000, order = 'asc' } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 2_000, 5_000));
      if (!['asc', 'desc'].includes(order)) throw new Error('WhatsApp message order must be asc or desc');
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
          AND wa_timestamp >= ?
          AND wa_timestamp <= ?
        ORDER BY wa_timestamp ${order.toUpperCase()}
        LIMIT ?
      `).all(groupJid, sinceMs, untilMs, boundedLimit);
    },

    getWhatsAppBacklogStats({ sinceMs = 0, untilMs = Date.now() } = {}) {
      const rows = db.prepare(`
        SELECT group_jid,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          MIN(wa_timestamp) AS oldest_at,
          MAX(wa_timestamp) AS newest_at
        FROM processed_messages
        WHERE status IN ('pending', 'failed')
          AND message_text IS NOT NULL
          AND wa_timestamp >= ? AND wa_timestamp <= ?
        GROUP BY group_jid
        ORDER BY group_jid
      `).all(Number(sinceMs), Number(untilMs));
      const groups = rows.map((row) => ({
        groupJid: row.group_jid,
        total: Number(row.total || 0),
        failed: Number(row.failed || 0),
        oldestAt: row.oldest_at == null ? null : Number(row.oldest_at),
        newestAt: row.newest_at == null ? null : Number(row.newest_at),
      }));
      return groups.reduce((summary, group) => ({
        total: summary.total + group.total,
        failed: summary.failed + group.failed,
        oldestAt: summary.oldestAt == null ? group.oldestAt : Math.min(summary.oldestAt, group.oldestAt),
        newestAt: summary.newestAt == null ? group.newestAt : Math.max(summary.newestAt, group.newestAt),
        groups: [...summary.groups, group],
      }), { total: 0, failed: 0, oldestAt: null, newestAt: null, groups: [] });
    },

    getWhatsAppGroupCollectionStats(groupJid) {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS total_collected,
          SUM(CASE WHEN status IN ('pending', 'failed') AND message_text IS NOT NULL THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'failed' AND message_text IS NOT NULL THEN 1 ELSE 0 END) AS failed,
          MAX(wa_timestamp) AS last_collected_at,
          MAX(CASE WHEN status = 'done' THEN wa_timestamp END) AS last_processed_at
        FROM processed_messages
        WHERE group_jid = ?
      `).get(groupJid);
      return {
        totalCollected: Number(row?.total_collected || 0),
        pending: Number(row?.pending || 0),
        failed: Number(row?.failed || 0),
        lastCollectedAt: row?.last_collected_at == null ? null : Number(row.last_collected_at),
        lastProcessedAt: row?.last_processed_at == null ? null : Number(row.last_processed_at),
      };
    },

    discardOldWhatsAppMessages({ beforeTs, discardedAt = Date.now() } = {}) {
      const cutoff = Number(beforeTs);
      const updatedAt = Number(discardedAt);
      if (!Number.isFinite(cutoff) || cutoff < 0) throw new Error('beforeTs must be a non-negative timestamp');
      if (!Number.isFinite(updatedAt) || updatedAt < 0) throw new Error('discardedAt must be a non-negative timestamp');
      return db.prepare(`
        UPDATE processed_messages
        SET status = 'done', message_text = NULL, last_error = NULL, updated_at = ?
        WHERE status IN ('pending', 'failed')
          AND message_text IS NOT NULL
          AND wa_timestamp < ?
      `).run(updatedAt, cutoff).changes;
    },

    getWhatsAppHistoryRequest(id) {
      const row = db.prepare('SELECT * FROM whatsapp_history_requests WHERE id = ?').get(Number(id));
      if (!row) return null;
      const groups = db.prepare('SELECT * FROM whatsapp_history_groups WHERE request_id = ? ORDER BY rowid')
        .all(Number(id)).map(mapWhatsAppHistoryGroup);
      return mapWhatsAppHistoryRequest(row, groups);
    },

    getLatestWhatsAppHistoryRequest() {
      const id = db.prepare('SELECT id FROM whatsapp_history_requests ORDER BY id DESC LIMIT 1').get()?.id;
      return id == null ? null : this.getWhatsAppHistoryRequest(id);
    },

    requestWhatsAppHistory({ fromTs, toTs, groupsTotal, groups = [], createdAt = Date.now() }) {
      const from = Number(fromTs);
      const to = Number(toTs);
      const total = Number(groupsTotal);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
        throw new Error('WhatsApp history window is invalid');
      }
      if (!Number.isInteger(total) || total < 1 || total > 100) {
        throw new Error('WhatsApp history groupsTotal must be between 1 and 100');
      }
      if (!Array.isArray(groups) || groups.length > 100 || (groups.length > 0 && groups.length !== total)) {
        throw new Error('WhatsApp history groups must match groupsTotal');
      }
      const normalizedGroups = groups.map((group) => {
        const name = requiredAuditField(group?.name, 'history group name', 200);
        const requestedFrom = Number(group?.requestedFrom);
        if (!Number.isSafeInteger(requestedFrom) || requestedFrom < from || requestedFrom >= to) {
          throw new Error('WhatsApp history group requestedFrom is outside the request window');
        }
        return { name, requestedFrom };
      });
      if (new Set(normalizedGroups.map((group) => group.name)).size !== normalizedGroups.length) {
        throw new Error('WhatsApp history group names must be unique');
      }
      const create = db.transaction(() => {
        const active = db.prepare("SELECT id FROM whatsapp_history_requests WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT 1").get();
        if (active) return { created: false, id: active.id };
        const id = db.prepare(`
          INSERT INTO whatsapp_history_requests (from_ts, to_ts, status, created_at, groups_total)
          VALUES (?, ?, 'pending', ?, ?)
        `).run(from, to, Number(createdAt), total).lastInsertRowid;
        const insertGroup = db.prepare(`
          INSERT INTO whatsapp_history_groups (
            request_id, group_name, status, requested_from, updated_at
          ) VALUES (?, ?, 'pending', ?, ?)
        `);
        for (const group of normalizedGroups) insertGroup.run(id, group.name, group.requestedFrom, Number(createdAt));
        return { created: true, id };
      })();
      return { created: create.created, request: this.getWhatsAppHistoryRequest(create.id) };
    },

    claimNextWhatsAppHistoryRequest({ ownerPid = process.pid, startedAt = Date.now() } = {}) {
      const claim = db.transaction(() => {
        const row = db.prepare("SELECT id FROM whatsapp_history_requests WHERE status = 'pending' ORDER BY created_at LIMIT 1").get();
        if (!row) return null;
        const changed = db.prepare(`
          UPDATE whatsapp_history_requests
          SET status = 'running', owner_pid = ?, started_at = ?, finished_at = NULL, diagnostic_json = NULL
          WHERE id = ? AND status = 'pending'
        `).run(Number(ownerPid), Number(startedAt), row.id).changes;
        return changed === 1 ? row.id : null;
      })();
      return claim == null ? null : this.getWhatsAppHistoryRequest(claim);
    },

    requeueInterruptedWhatsAppHistoryRequests() {
      const running = db.prepare("SELECT id, owner_pid FROM whatsapp_history_requests WHERE status = 'running'").all();
      let recovered = 0;
      for (const row of running) {
        if (processState(row.owner_pid) !== 'dead') continue;
        recovered += db.prepare(`
          UPDATE whatsapp_history_requests
          SET status = 'pending', owner_pid = NULL, started_at = NULL, current_group = NULL,
              groups_completed = 0, messages_received = 0, messages_queued = 0,
              duplicates = 0, ignored = 0, rejected = 0, diagnostic_json = NULL
          WHERE id = ? AND status = 'running'
        `).run(row.id).changes;
        db.prepare(`
          UPDATE whatsapp_history_groups
          SET status = 'pending', delivered = 0, queued = 0, duplicates = 0,
              ignored = 0, rejected = 0, oldest_at = NULL, newest_at = NULL,
              batches = 0, reason = NULL, updated_at = ?
          WHERE request_id = ?
        `).run(Date.now(), row.id);
      }
      return recovered;
    },

    updateWhatsAppHistoryRequest(id, fields = {}) {
      const allowed = new Map([
        ['currentGroup', 'current_group'], ['groupsCompleted', 'groups_completed'],
        ['messagesReceived', 'messages_received'], ['messagesQueued', 'messages_queued'],
        ['duplicates', 'duplicates'], ['ignored', 'ignored'], ['rejected', 'rejected'],
      ]);
      const assignments = [];
      const values = [];
      for (const [key, column] of allowed) {
        if (!Object.hasOwn(fields, key)) continue;
        const value = key === 'currentGroup' ? (fields[key] == null ? null : requiredAuditField(fields[key], 'history current group', 200)) : Number(fields[key]);
        if (key !== 'currentGroup' && (!Number.isInteger(value) || value < 0)) throw new Error(`${key} must be a non-negative integer`);
        assignments.push(`${column} = ?`);
        values.push(value);
      }
      if (!assignments.length) return false;
      values.push(Number(id));
      return db.prepare(`UPDATE whatsapp_history_requests SET ${assignments.join(', ')} WHERE id = ? AND status = 'running'`)
        .run(...values).changes === 1;
    },

    recordWhatsAppHistoryGroup(requestId, {
      name, status, delivered = 0, queued = 0, duplicates = 0, ignored = 0, rejected = 0,
      oldestAt = null, newestAt = null, batches = 0, reason = null, requestedFrom = null, updatedAt = Date.now(),
    }) {
      const counts = [delivered, queued, duplicates, ignored, rejected, batches].map(Number);
      if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('WhatsApp history group counts must be non-negative integers');
      const normalizedRequestedFrom = requestedFrom == null ? null : Number(requestedFrom);
      if (normalizedRequestedFrom != null && (!Number.isSafeInteger(normalizedRequestedFrom) || normalizedRequestedFrom < 0)) {
        throw new Error('WhatsApp history group requestedFrom must be a non-negative timestamp');
      }
      db.prepare(`
        INSERT INTO whatsapp_history_groups (
          request_id, group_name, status, requested_from, delivered, queued, duplicates, ignored, rejected,
          oldest_at, newest_at, batches, reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id, group_name) DO UPDATE SET
          status = excluded.status, delivered = excluded.delivered, queued = excluded.queued,
          duplicates = excluded.duplicates, ignored = excluded.ignored, rejected = excluded.rejected,
          requested_from = COALESCE(excluded.requested_from, whatsapp_history_groups.requested_from),
          oldest_at = excluded.oldest_at, newest_at = excluded.newest_at,
          batches = excluded.batches, reason = excluded.reason, updated_at = excluded.updated_at
      `).run(
        Number(requestId), requiredAuditField(name, 'history group name', 200),
        requiredAuditField(status, 'history group status', 32), normalizedRequestedFrom, ...counts.slice(0, 5),
        oldestAt == null ? null : Number(oldestAt), newestAt == null ? null : Number(newestAt),
        counts[5], reason == null ? null : String(reason).slice(0, 128), Number(updatedAt),
      );
    },

    finishWhatsAppHistoryRequest(id, { status, failure = null, finishedAt = Date.now() } = {}) {
      if (!['complete', 'partial', 'failed'].includes(status)) throw new Error('WhatsApp history terminal status is invalid');
      return db.prepare(`
        UPDATE whatsapp_history_requests
        SET status = ?, finished_at = ?, current_group = NULL, diagnostic_json = ?
        WHERE id = ? AND status = 'running'
      `).run(status, Number(finishedAt), serializeAuditDetails(failure), Number(id)).changes === 1;
    },

    listWhatsAppMessageKeys(groupJid, { limit = 2_000 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 2_000, 5_000));
      return db.prepare(`
        SELECT message_id AS id, group_jid AS remoteJid
        FROM processed_messages
        WHERE group_jid = ? AND message_id IS NOT NULL
        ORDER BY wa_timestamp DESC
        LIMIT ?
      `).all(groupJid, boundedLimit).map((key) => ({ ...key, fromMe: false }));
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

    startRun({ fromTs, toTs, sources, startedAt = Date.now(), ownerPid = null, actionId = null }) {
      return db.prepare(`
        INSERT INTO runs (started_at, from_ts, to_ts, sources, status, owner_pid, heartbeat_at, stage, action_id)
        VALUES (?, ?, ?, ?, 'running', ?, ?, 'setup', ?)
      `).run(startedAt, fromTs, toTs, JSON.stringify(sources), ownerPid, startedAt, actionId).lastInsertRowid;
    },

    touchRun(runId, { stage = null, details = null } = {}) {
      db.prepare("UPDATE runs SET heartbeat_at = ?, stage = COALESCE(?, stage), details_json = COALESCE(?, details_json) WHERE id = ? AND status = 'running'")
        .run(Date.now(), stage, details ? JSON.stringify(details) : null, runId);
    },

    finishRun(runId, { status, error = null, details = null, failure = null, finishedAt = Date.now() }) {
      db.prepare('UPDATE runs SET finished_at = ?, status = ?, error = ?, details_json = COALESCE(?, details_json), diagnostic_json = ? WHERE id = ?')
        .run(finishedAt, status, error ?? null, details ? JSON.stringify(details) : null, serializeAuditDetails(failure), runId);
    },

    recordRunEvent(runId, {
      source,
      scope,
      scopeKey = null,
      stage,
      status,
      count = null,
      details = null,
      createdAt = Date.now(),
    }) {
      const normalizedCount = count == null ? null : Number(count);
      if (normalizedCount != null && (!Number.isInteger(normalizedCount) || normalizedCount < 0)) {
        throw new Error('run event count must be a non-negative integer');
      }
      return db.prepare(`
        INSERT INTO run_events (
          run_id, source, scope, scope_key, stage, status, item_count, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        requiredAuditField(source, 'run event source', 32),
        requiredAuditField(scope, 'run event scope', 32),
        scopeKey == null ? null : requiredAuditField(scopeKey, 'run event scope key', 200),
        requiredAuditField(stage, 'run event stage', 64),
        requiredAuditField(status, 'run event status', 32),
        normalizedCount,
        serializeAuditDetails(details),
        Number(createdAt),
      ).lastInsertRowid;
    },

    listRunEvents(runId, { limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2_000));
      return db.prepare(`
        SELECT
          id,
          run_id AS runId,
          source,
          scope,
          scope_key AS scopeKey,
          stage,
          status,
          item_count AS count,
          details_json AS detailsJson,
          created_at AS createdAt
        FROM run_events
        WHERE run_id = ?
        ORDER BY id ASC
        LIMIT ?
      `).all(runId, boundedLimit).map(({ detailsJson, ...event }) => ({
        ...event,
        details: parseJson(detailsJson, null),
      }));
    },

    getLastRun() {
      const row = db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get();
      return row ? this.getRun(row.id) : null;
    },

    getLastRunSummary() {
      const row = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
      if (!row) return null;
      const { details_json: detailsJson, diagnostic_json: diagnosticJson, ...run } = row;
      return observedRun({
        ...run,
        diagnostic: parseJson(diagnosticJson),
        details: parseJson(detailsJson),
      });
    },

    getRun(id) {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
      if (!row) return null;
      const { details_json: detailsJson, diagnostic_json: diagnosticJson, ...run } = row;
      // The detail view uses the newest events, including the terminal failure,
      // even when a scan produced more than the display limit.
      const events = db.prepare('SELECT id FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 500').all(id);
      const firstId = events.at(-1)?.id || 0;
      const rows = db.prepare('SELECT * FROM run_events WHERE run_id = ? AND id >= ? ORDER BY id').all(id, firstId);
      return observedRun({ ...run, diagnostic: parseJson(diagnosticJson), details: parseJson(detailsJson),
        eventCount: db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?').get(id).count,
        events: rows.map((event) => ({ id: event.id, runId: id, source: event.source, scope: event.scope,
          scopeKey: event.scope_key, stage: event.stage, status: event.status, count: event.item_count,
          createdAt: event.created_at, details: parseJson(event.details_json) })),
      });
    },

    startAction(name, { ownerPid = process.pid } = {}) {
      return db.prepare("INSERT INTO action_runs (name, started_at, status, owner_pid) VALUES (?, ?, 'running', ?)")
        .run(requiredAuditField(name, 'action name'), Date.now(), ownerPid).lastInsertRowid;
    },

    updateAction(id, { childPid = null, status = 'running', failure = null, warnings = [], finishedAt = null } = {}) {
      db.prepare('UPDATE action_runs SET child_pid = COALESCE(?, child_pid), status = ?, diagnostic_json = ?, warnings_json = ?, finished_at = ? WHERE id = ?')
        .run(childPid, status, serializeAuditDetails(failure), serializeAuditDetails(warnings.slice(0, 30)), finishedAt, id);
    },

    getAction(id) {
      const row = db.prepare('SELECT * FROM action_runs WHERE id = ?').get(id);
      if (!row) return null;
      const { diagnostic_json, warnings_json, ...action } = row;
      action.diagnostic = parseJson(diagnostic_json);
      action.warnings = parseJson(warnings_json, []);
      if (action.status === 'running' && processState(action.child_pid || action.owner_pid) === 'dead') {
        action.recordedStatus = 'running';
        action.status = 'interrupted';
        action.diagnostic = describeFailure(null, 'process_missing');
      }
      action.runIds = db.prepare('SELECT id FROM runs WHERE action_id = ? ORDER BY id DESC').all(id).map((run) => run.id);
      return action;
    },

    startCollectorRun({ ownerPid = process.pid, startedAt = Date.now(), groupsExpected = null } = {}) {
      return db.prepare(`
        INSERT INTO collector_runs (
          started_at, status, owner_pid, heartbeat_at, stage, groups_expected
        ) VALUES (?, 'starting', ?, ?, 'startup', ?)
      `).run(startedAt, ownerPid, startedAt, groupsExpected).lastInsertRowid;
    },

    updateCollectorRun(id, fields = {}) {
      const allowed = new Map([
        ['status', 'status'], ['stage', 'stage'], ['connectedAt', 'connected_at'],
        ['lastMessageAt', 'last_message_at'], ['groupsFound', 'groups_found'],
        ['groupsExpected', 'groups_expected'], ['diagnostic', 'diagnostic_json'],
      ]);
      const increments = new Map([
        ['messagesReceived', 'messages_received'], ['messagesQueued', 'messages_queued'],
        ['duplicates', 'duplicates'], ['ignored', 'ignored'], ['rejected', 'rejected'],
        ['receiptsSent', 'receipts_sent'], ['reconnects', 'reconnects'],
      ]);
      const assignments = ['heartbeat_at = ?'];
      const values = [Date.now()];
      for (const [key, column] of allowed) {
        if (!Object.hasOwn(fields, key)) continue;
        assignments.push(`${column} = ?`);
        values.push(key === 'diagnostic' ? serializeAuditDetails(fields[key]) : fields[key]);
      }
      for (const [key, column] of increments) {
        if (!Object.hasOwn(fields, key)) continue;
        const amount = Number(fields[key]);
        if (!Number.isInteger(amount) || amount < 0) throw new Error(`${key} must be a non-negative integer`);
        assignments.push(`${column} = ${column} + ?`);
        values.push(amount);
      }
      values.push(id);
      return db.prepare(`UPDATE collector_runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values).changes === 1;
    },

    recordCollectorEvent(collectorRunId, {
      stage,
      status,
      count = null,
      details = null,
      createdAt = Date.now(),
    }) {
      const normalizedCount = count == null ? null : Number(count);
      if (normalizedCount != null && (!Number.isInteger(normalizedCount) || normalizedCount < 0)) {
        throw new Error('collector event count must be a non-negative integer');
      }
      return db.prepare(`
        INSERT INTO collector_events (
          collector_run_id, stage, status, item_count, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        collectorRunId,
        requiredAuditField(stage, 'collector event stage', 64),
        requiredAuditField(status, 'collector event status', 32),
        normalizedCount,
        serializeAuditDetails(details),
        Number(createdAt),
      ).lastInsertRowid;
    },

    finishCollectorRun(id, { status, failure = null, finishedAt = Date.now() } = {}) {
      db.prepare(`
        UPDATE collector_runs SET
          finished_at = ?, status = ?, heartbeat_at = ?, diagnostic_json = ?
        WHERE id = ?
      `).run(finishedAt, requiredAuditField(status, 'collector status', 32), finishedAt, serializeAuditDetails(failure), id);
    },

    getCollectorRunSummary(id) {
      const row = db.prepare('SELECT * FROM collector_runs WHERE id = ?').get(id);
      if (!row) return null;
      const { diagnostic_json: diagnosticJson, ...collector } = row;
      collector.diagnostic = parseJson(diagnosticJson);
      if (['starting', 'connecting', 'connected', 'reconnecting', 'pairing_required'].includes(collector.status)) {
        const state = processState(collector.owner_pid);
        if (state === 'dead') {
          collector.recordedStatus = collector.status;
          collector.status = 'interrupted';
          collector.diagnostic = describeFailure(null, 'process_missing');
        } else if (Date.now() - Number(collector.heartbeat_at || 0) > 60_000) {
          collector.recordedStatus = collector.status;
          collector.status = 'unconfirmed';
          collector.diagnostic = describeFailure(null, 'heartbeat_stale');
        }
      }
      return collector;
    },

    getCollectorRun(id) {
      const collector = this.getCollectorRunSummary(id);
      if (!collector) return null;
      collector.eventCount = db.prepare('SELECT COUNT(*) AS count FROM collector_events WHERE collector_run_id = ?').get(id).count;
      collector.events = db.prepare(`
        SELECT id, stage, status, item_count AS count, details_json AS detailsJson, created_at AS createdAt
        FROM collector_events WHERE collector_run_id = ? ORDER BY id DESC LIMIT 500
      `).all(id).reverse().map(({ detailsJson, ...event }) => ({ ...event, details: parseJson(detailsJson) }));
      return collector;
    },

    getCollectorStatus() {
      const row = db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 1').get();
      return row ? this.getCollectorRun(row.id) : null;
    },

    getCollectorStatusSummary() {
      const row = db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 1').get();
      return row ? this.getCollectorRunSummary(row.id) : null;
    },

    pruneDiagnostics({ keepRecent = 3 } = {}) {
      const limit = Number(keepRecent);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('keepRecent must be an integer between 1 and 20');
      }
      const prune = db.transaction(() => {
        const before = {
          runs: db.prepare('SELECT COUNT(*) AS count FROM runs').get().count,
          runEvents: db.prepare('SELECT COUNT(*) AS count FROM run_events').get().count,
          actions: db.prepare('SELECT COUNT(*) AS count FROM action_runs').get().count,
          collectors: db.prepare('SELECT COUNT(*) AS count FROM collector_runs').get().count,
          collectorEvents: db.prepare('SELECT COUNT(*) AS count FROM collector_events').get().count,
        };
        const runs = db.prepare('SELECT id, sources, status FROM runs ORDER BY id DESC').all();
        const recentRunIds = new Set(runs.slice(0, limit).map((run) => run.id));
        const retainedRunIds = new Set(recentRunIds);
        const successfulSourceSets = new Set();
        for (const run of runs) {
          if (run.status !== 'success') continue;
          const sourceKey = JSON.stringify([...parseSources(run.sources)].sort());
          if (successfulSourceSets.has(sourceKey)) continue;
          successfulSourceSets.add(sourceKey);
          retainedRunIds.add(run.id);
        }

        const deleteEvents = db.prepare('DELETE FROM run_events WHERE run_id = ?');
        const deleteRun = db.prepare('DELETE FROM runs WHERE id = ?');
        const compactRun = db.prepare('UPDATE runs SET error = NULL, details_json = NULL, diagnostic_json = NULL, action_id = NULL WHERE id = ?');
        for (const run of runs) {
          if (!recentRunIds.has(run.id)) deleteEvents.run(run.id);
          if (!retainedRunIds.has(run.id)) deleteRun.run(run.id);
          else if (!recentRunIds.has(run.id)) compactRun.run(run.id);
        }

        const actionIds = db.prepare('SELECT id FROM action_runs ORDER BY id DESC').all();
        for (const { id } of actionIds.slice(limit)) db.prepare('DELETE FROM action_runs WHERE id = ?').run(id);
        const collectorIds = db.prepare('SELECT id FROM collector_runs ORDER BY id DESC').all();
        for (const { id } of collectorIds.slice(limit)) db.prepare('DELETE FROM collector_runs WHERE id = ?').run(id);

        const after = {
          runs: db.prepare('SELECT COUNT(*) AS count FROM runs').get().count,
          runEvents: db.prepare('SELECT COUNT(*) AS count FROM run_events').get().count,
          actions: db.prepare('SELECT COUNT(*) AS count FROM action_runs').get().count,
          collectors: db.prepare('SELECT COUNT(*) AS count FROM collector_runs').get().count,
          collectorEvents: db.prepare('SELECT COUNT(*) AS count FROM collector_events').get().count,
        };
        return {
          runsDeleted: before.runs - after.runs,
          eventsDeleted: (before.runEvents - after.runEvents) + (before.collectorEvents - after.collectorEvents),
          actionsDeleted: before.actions - after.actions,
          collectorsDeleted: before.collectors - after.collectors,
        };
      });
      return prune();
    },

    diagnosticHistory() {
      // This API is retained for CLI/support compatibility. The daily UI only shows
      // the newest result and automatic diagnosis.
      const runs = db.prepare('SELECT id, started_at, finished_at, status, sources, stage, owner_pid, heartbeat_at FROM runs ORDER BY id DESC LIMIT 3')
        .all().map((run) => ({ ...observedRun(run), kind: 'runs' }));
      const actions = db.prepare('SELECT id FROM action_runs ORDER BY id DESC LIMIT 3').all()
        .map(({ id }) => ({ ...this.getAction(id), kind: 'actions' }));
      const collectors = db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 3').all()
        .map(({ id }) => ({ ...this.getCollectorRunSummary(id), kind: 'collectors' }));
      return [...runs, ...actions, ...collectors].sort((a, b) => b.started_at - a.started_at);
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
