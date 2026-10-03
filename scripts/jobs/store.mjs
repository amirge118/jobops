import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { canonicalizeJobUrl, companyIdentityKey, normalizeCompanyRole, resumeGapInputHash } from './core.mjs';
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
import { linkedinQueryHash } from './linkedin-window.mjs';

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

const SOURCE_KINDS = new Set(['ats', 'whatsapp', 'linkedin']);

// Calendar day in Israel for a UTC timestamp (YYYY-MM-DD).
export function israelDay(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Number(timestamp)));
}

function normalizeSourceMix(mix) {
  if (!mix || typeof mix !== 'object') return null;
  const clean = Object.fromEntries(Object.entries(mix)
    .filter(([source, count]) => (SOURCE_KINDS.has(source) || source === 'other') && Number.isInteger(count) && count > 0));
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export function sourceKindOf(source) {
  const value = String(source || '');
  if (/^whatsapp:/i.test(value)) return 'whatsapp';
  if (/^linkedin:/i.test(value)) return 'linkedin';
  if (/^ats:/i.test(value)) return 'ats';
  return 'other';
}

export function sourceMixOf(sources) {
  const mix = {};
  for (const source of sources) {
    const kind = sourceKindOf(source);
    mix[kind] = (mix[kind] || 0) + 1;
  }
  return mix;
}

// The retry source a sighting kind maps back to (the prefix filters match on).
const SIGHTING_RETRY_SOURCES = { ats: 'ATS: retry', whatsapp: 'WhatsApp: retry', linkedin: 'LinkedIn: retry' };

function sourceKinds(sources) {
  const kinds = new Set();
  for (const source of sources) {
    if (/^whatsapp:/i.test(source)) kinds.add('whatsapp');
    else if (/^linkedin:/i.test(source)) kinds.add('linkedin');
    else if (/^ats:/i.test(source)) kinds.add('ats');
  }
  return [...kinds];
}

const LINKEDIN_KEYWORDS_PATTERN = /^[\p{L}\p{N} "'()+#.&/,-]+$/u;

function normalizeLinkedInSearch(input = {}) {
  const text = (value, max) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
  const keywords = text(input.keywords, 200);
  const label = text(input.label, 80) || keywords.slice(0, 80);
  const location = text(input.location, 120) || null;
  const geoId = text(input.geoId ?? input.geo_id, 20) || null;
  const key = text(input.key ?? input.search_key, 64) || null;
  if (!keywords || !LINKEDIN_KEYWORDS_PATTERN.test(keywords)) {
    throw Object.assign(new Error('LinkedIn keywords are required and may contain only letters, digits, spaces, quotes and basic punctuation'), { statusCode: 400 });
  }
  if (location && !LINKEDIN_KEYWORDS_PATTERN.test(location)) {
    throw Object.assign(new Error('LinkedIn location contains unsupported characters'), { statusCode: 400 });
  }
  if (geoId && !/^\d{1,20}$/.test(geoId)) throw Object.assign(new Error('LinkedIn geoId must be numeric'), { statusCode: 400 });
  if (!location && !geoId) throw Object.assign(new Error('A LinkedIn search needs a location or geoId'), { statusCode: 400 });
  if (key && !/^[a-z0-9_-]+$/i.test(key)) throw Object.assign(new Error('LinkedIn search key is invalid'), { statusCode: 400 });
  return { key, label, keywords, location, geoId, enabled: input.enabled !== false && input.enabled !== 0 };
}

function linkedinJobIdFromCanonical(canonical) {
  return canonical.match(/^https:\/\/www\.linkedin\.com\/jobs\/view\/(\d+)$/)?.[1] ?? null;
}

function mapLinkedInSearch(row) {
  return {
    id: row.id,
    key: row.search_key,
    label: row.label,
    keywords: row.keywords,
    location: row.location,
    geoId: row.geo_id,
    enabled: Boolean(row.enabled),
    origin: row.origin,
    queryHash: row.query_hash,
    coveredUntil: row.covered_until ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    lastStatus: row.last_status ?? null,
    lastReason: row.last_reason ?? null,
    lastSummary: parseJson(row.last_summary_json, null),
    gaps: parseJson(row.gaps_json, []),
  };
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

const PERSONAL_IMPROVEMENT_KINDS = new Set(['safe_addition', 'experience_gap', 'needs_confirmation']);
const PERSONAL_IMPROVEMENT_IMPORTANCE = new Set(['required', 'preferred']);
export const JOB_DECISIONS = new Set(['interested', 'company_candidate', 'company_not_interesting', 'too_senior', 'not_relevant']);
const FIT_DIMENSION_KEYS = ['cvMatch', 'seniority', 'roleScope', 'location', 'sector'];

function mapJobDecision(row) {
  return {
    jobKey: row.job_key,
    decision: row.decision,
    decidedAt: row.decided_at,
    company: row.company,
    title: row.title,
    applyUrl: row.apply_url,
    score: row.score,
    fitLabel: row.fit_label,
    fit: parseJson(row.fit_json, null),
    sourceKinds: parseJson(row.source_kinds_json, []),
    screenPass: row.screen_pass,
    criteriaVersion: row.criteria_version,
    firstSeenAt: row.first_seen_at,
  };
}

function compactText(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function mapPersonalImprovement(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyword: row.keyword,
    kind: row.kind,
    importance: row.importance,
    explanation: row.explanation,
    suggestion: row.suggestion,
    sourceCompany: row.source_company,
    sourceTitle: row.source_title,
    sourceJobKey: row.source_job_key,
    createdAt: row.created_at,
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
  // WAL allows concurrent readers but still only one writer at a time. The
  // single-instance scan lock (see jobs/single-instance.mjs) keeps two scans
  // from overlapping, but a short-lived writer (a dashboard action, a probe)
  // can still legitimately hold a write transaction for a moment — wait
  // rather than fail outright on that brief contention.
  db.pragma('busy_timeout = 5000');

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
      last_attempted_at INTEGER,
      resume_gap_json TEXT,
      resume_gap_input_hash TEXT,
      resume_gap_analyzed_at INTEGER,
      resume_gap_error_code TEXT,
      resume_gap_error_reason TEXT,
      resume_gap_last_attempted_at INTEGER
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
      read_at       INTEGER,
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
        CHECK(provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'comeet', 'official-html', 'embedded-json', 'workday', 'zoho-recruit', 'teamme', 'unsupported')),
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

    CREATE TABLE IF NOT EXISTS personal_improvements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK(kind IN ('safe_addition', 'experience_gap', 'needs_confirmation')),
      importance TEXT NOT NULL DEFAULT 'preferred'
        CHECK(importance IN ('required', 'preferred')),
      explanation TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      source_company TEXT,
      source_title TEXT,
      source_job_key TEXT,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(keyword, source_job_key)
    );

    CREATE INDEX IF NOT EXISTS personal_improvements_position_idx
      ON personal_improvements(position);

    -- What the user did with a job shown on the Decisions page. Written in
    -- the same transaction that archives (and wipes) the job, so this is the
    -- only durable record of the job's content — kept small and local, for
    -- statistics and score calibration, never for re-scoring.
    CREATE TABLE IF NOT EXISTS job_decisions (
      job_key TEXT PRIMARY KEY,
      decision TEXT NOT NULL
        CHECK(decision IN ('interested', 'company_candidate', 'company_not_interesting', 'too_senior', 'not_relevant')),
      decided_at INTEGER NOT NULL,
      company TEXT,
      title TEXT,
      apply_url TEXT,
      score REAL,
      fit_label TEXT,
      fit_json TEXT,
      source_kinds_json TEXT NOT NULL DEFAULT '[]',
      screen_pass TEXT,
      criteria_version TEXT,
      first_seen_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS job_decisions_decided_idx ON job_decisions(decided_at);

    -- Companies the user marked "not interesting" on the decisions page. New
    -- jobs from them are rejected locally, before any page fetch or scoring.
    -- Filled only by new decisions; older decisions were deliberately not
    -- backfilled.
    -- Cross-run LinkedIn pacing. Per-run budgets cannot stop a run that
    -- starts minutes after another one exhausted LinkedIn's patience.
    CREATE TABLE IF NOT EXISTS linkedin_state (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      blocked_until    INTEGER,
      blocked_reason   TEXT,
      blocked_at       INTEGER,
      last_activity_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS blocked_companies (
      company_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      blocked_at INTEGER NOT NULL
    );

    -- Source-value history. Unlike runs (pruned to the last few) and job
    -- content (wiped on rejection/archive), these small rows are durable so
    -- per-source yield can be measured over weeks. No job text is stored.
    CREATE TABLE IF NOT EXISTS job_source_sightings (
      job_key TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('ats', 'whatsapp', 'linkedin')),
      company TEXT,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (job_key, source_kind)
    );

    CREATE INDEX IF NOT EXISTS job_source_sightings_seen_idx ON job_source_sightings(first_seen_at);

    CREATE TABLE IF NOT EXISTS source_scan_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      scanned_at INTEGER NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('ats', 'whatsapp', 'linkedin')),
      seconds REAL,
      found INTEGER NOT NULL DEFAULT 0,
      filtered_title INTEGER NOT NULL DEFAULT 0,
      filtered_location INTEGER NOT NULL DEFAULT 0,
      filtered_recency INTEGER NOT NULL DEFAULT 0,
      candidates INTEGER NOT NULL DEFAULT 0,
      scored INTEGER NOT NULL DEFAULT 0,
      suitable INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS source_scan_stats_scanned_idx ON source_scan_stats(scanned_at);
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
  if (!['comeet', 'official-html', 'embedded-json', 'workday', 'zoho-recruit', 'teamme'].every((provider) => companySourcesSql.includes(`'${provider}'`))) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE company_job_sources RENAME TO company_job_sources_legacy;
        CREATE TABLE company_job_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL,
          source_key TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL
            CHECK(provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'comeet', 'official-html', 'embedded-json', 'workday', 'zoho-recruit', 'teamme', 'unsupported')),
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
  for (const [name, type] of Object.entries({ owner_pid: 'INTEGER', heartbeat_at: 'INTEGER', stage: 'TEXT', action_id: 'INTEGER', diagnostic_json: 'TEXT', window_status: 'TEXT' })) {
    if (!runColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }

  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all();
  if (!jobColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }
  // Durable outcome timestamps for source-value metrics: never cleared by
  // rejection or archiving (which wipe the job's content, not these facts).
  if (!jobColumns.some((column) => column.name === 'first_scored_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN first_scored_at INTEGER');
    db.exec('ALTER TABLE jobs ADD COLUMN first_suitable_at INTEGER');
    // Best-effort backfill from what survives today; exact from here on.
    // Rejected rows keep no trace of how they were rejected, so only suitable
    // ones are known to have been model-scored.
    db.exec(`UPDATE jobs SET first_scored_at = evaluated_at WHERE evaluated_at IS NOT NULL AND suitable = 1`);
    db.exec(`UPDATE jobs SET first_suitable_at = evaluated_at WHERE evaluated_at IS NOT NULL AND suitable = 1`);
    db.exec(`
      UPDATE jobs SET first_suitable_at = (SELECT decided_at FROM job_decisions d WHERE d.job_key = jobs.job_key)
      WHERE first_suitable_at IS NULL AND job_key IN (SELECT job_key FROM job_decisions)
    `);
    const insertSighting = db.prepare(`
      INSERT OR IGNORE INTO job_source_sightings (job_key, source_kind, company, first_seen_at) VALUES (?, ?, ?, ?)
    `);
    for (const row of db.prepare("SELECT job_key, company, sources_json, first_seen_at FROM jobs WHERE sources_json <> '[]'").all()) {
      for (const kind of sourceKinds(parseSources(row.sources_json))) insertSighting.run(row.job_key, kind, row.company, row.first_seen_at);
    }
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
  for (const [name, type] of Object.entries({
    resume_gap_json: 'TEXT',
    resume_gap_input_hash: 'TEXT',
    resume_gap_analyzed_at: 'INTEGER',
    resume_gap_error_code: 'TEXT',
    resume_gap_error_reason: 'TEXT',
    resume_gap_last_attempted_at: 'INTEGER',
    possible_duplicate_of: 'TEXT',
    duplicate_of: 'TEXT',
  })) {
    if (!jobColumns.some((column) => column.name === name)) {
      try {
        db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      } catch (error) {
        if (!new RegExp(`duplicate column name:\\s*${name}`, 'i').test(String(error?.message || ''))) {
          throw error;
        }
      }
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS jobs_archived_idx ON jobs(archived_at)');

  const processedMessageColumns = db.prepare('PRAGMA table_info(processed_messages)').all();
  if (!processedMessageColumns.some((column) => column.name === 'message_text')) {
    db.exec('ALTER TABLE processed_messages ADD COLUMN message_text TEXT');
  }
  if (!processedMessageColumns.some((column) => column.name === 'read_at')) {
    try {
      db.exec('ALTER TABLE processed_messages ADD COLUMN read_at INTEGER');
    } catch (error) {
      // Two local processes can open the database during a dashboard action.
      // If the other process won this additive migration race, the desired
      // schema already exists and both versions remain compatible.
      if (!/duplicate column name:\s*read_at/i.test(String(error?.message || ''))) throw error;
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS processed_messages_pending_idx
    ON processed_messages(group_jid, status, wa_timestamp)
  `);
  const whatsappHistoryGroupColumns = db.prepare('PRAGMA table_info(whatsapp_history_groups)').all();
  if (!whatsappHistoryGroupColumns.some((column) => column.name === 'requested_from')) {
    db.exec('ALTER TABLE whatsapp_history_groups ADD COLUMN requested_from INTEGER');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS linkedin_searches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      search_key  TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      keywords    TEXT NOT NULL,
      location    TEXT,
      geo_id      TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      origin      TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('config', 'user')),
      query_hash  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- One row per (search, query version): a meaningful query edit gets a
    -- fresh starting point instead of inheriting the old query's coverage.
    CREATE TABLE IF NOT EXISTS linkedin_search_progress (
      search_id         INTEGER NOT NULL REFERENCES linkedin_searches(id) ON DELETE CASCADE,
      query_hash        TEXT NOT NULL,
      covered_until     INTEGER,
      last_success_at   INTEGER,
      last_attempt_at   INTEGER,
      last_status       TEXT,
      last_reason       TEXT,
      last_summary_json TEXT,
      gaps_json         TEXT,
      PRIMARY KEY (search_id, query_hash)
    );

    -- Technical identity only (no title/company): enough to recognize a
    -- posting again and to link it to its company-site URL when LinkedIn
    -- exposes one.
    CREATE TABLE IF NOT EXISTS linkedin_postings (
      linkedin_id            TEXT PRIMARY KEY,
      job_key                TEXT NOT NULL,
      external_canonical_url TEXT,
      listed_at              TEXT,
      first_seen_at          INTEGER NOT NULL,
      last_seen_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS linkedin_postings_job_idx ON linkedin_postings(job_key);

    -- Messages for the person about a strong new job. A scan run only queues
    -- them; the WhatsApp collector, which owns the only connection, sends
    -- them. One row per job, so a job is never announced twice.
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_key     TEXT NOT NULL UNIQUE,
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );

    -- One row per Codex call: what it was for, which model, how many jobs,
    -- and the tokens it used (from codex exec --json). Kept 90 days.
    CREATE TABLE IF NOT EXISTS codex_calls (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER,
      purpose             TEXT NOT NULL,
      model               TEXT,
      reasoning_effort    TEXT,
      items               INTEGER,
      input_tokens        INTEGER,
      cached_input_tokens INTEGER,
      output_tokens       INTEGER,
      reasoning_tokens    INTEGER,
      duration_ms         INTEGER,
      ok                  INTEGER NOT NULL,
      error_code          TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS codex_calls_created_idx ON codex_calls(created_at);
    CREATE INDEX IF NOT EXISTS codex_calls_run_idx ON codex_calls(run_id);

    -- Per Israel-calendar-day and source: how many jobs were scored and how
    -- many came out suitable (counted when scored, so later archiving or
    -- rejection cleanup cannot erase the attribution).
    CREATE TABLE IF NOT EXISTS source_daily_outcomes (
      day      TEXT NOT NULL,
      source   TEXT NOT NULL,
      scored   INTEGER NOT NULL DEFAULT 0,
      suitable INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, source)
    );

    -- Single-row LLM quota state: when the account hit its usage limit and
    -- when that resets, and the last call that succeeded.
    CREATE TABLE IF NOT EXISTS llm_state (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      blocked_until   INTEGER,
      blocked_reason  TEXT,
      blocked_at      INTEGER,
      last_success_at INTEGER,
      last_skip_at    INTEGER,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_settings (
      source     TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // Estimated LinkedIn posting time from the card's "N hours ago" label;
  // listed_at alone is only a date.
  if (!db.prepare('PRAGMA table_info(linkedin_postings)').all().some((column) => column.name === 'posted_at')) {
    db.exec('ALTER TABLE linkedin_postings ADD COLUMN posted_at INTEGER');
  }

  if (!db.prepare('PRAGMA table_info(codex_calls)').all().some((column) => column.name === 'source_mix')) {
    try { db.exec('ALTER TABLE codex_calls ADD COLUMN source_mix TEXT'); }
    catch (error) { if (!/duplicate column name:\s*source_mix/i.test(String(error?.message || ''))) throw error; }
  }

  // LinkedIn URLs used to be keyed with their slug/subdomain/tracking params.
  // Re-key them to the stable posting id when that cannot collide; job_key
  // stays as-is and colliding rows are left untouched rather than deleted.
  {
    const legacyLinkedIn = db.prepare(`
      SELECT job_key, canonical_url FROM jobs
      WHERE canonical_url LIKE '%linkedin.com/%'
    `).all();
    const takenUrl = db.prepare('SELECT 1 FROM jobs WHERE canonical_url = ?');
    const rekey = db.prepare('UPDATE jobs SET canonical_url = ? WHERE job_key = ?');
    for (const row of legacyLinkedIn) {
      const normalized = canonicalizeJobUrl(row.canonical_url);
      if (normalized && normalized !== row.canonical_url && !takenUrl.get(normalized)) {
        rekey.run(normalized, row.job_key);
      }
    }
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
      resume_gap_json = NULL,
      resume_gap_input_hash = NULL,
      resume_gap_analyzed_at = NULL,
      resume_gap_error_code = NULL,
      resume_gap_error_reason = NULL,
      resume_gap_last_attempted_at = NULL,
      apply_url = canonical_url,
      sources_json = '[]'
    WHERE suitable = 0 AND evaluated_at IS NOT NULL
  `);

  db.exec(`
    UPDATE linkedin_postings SET external_canonical_url = NULL
    WHERE job_key IN (SELECT job_key FROM jobs WHERE suitable = 0 AND evaluated_at IS NOT NULL)
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
      resume_gap_json = NULL,
      resume_gap_input_hash = NULL,
      resume_gap_analyzed_at = NULL,
      resume_gap_error_code = NULL,
      resume_gap_error_reason = NULL,
      resume_gap_last_attempted_at = NULL,
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

  const insertSourceSighting = db.prepare(`
    INSERT OR IGNORE INTO job_source_sightings (job_key, source_kind, company, first_seen_at) VALUES (?, ?, ?, ?)
  `);
  // First time each source kind saw a job — survives rejection and archiving,
  // so a source's exclusive finds and lead time can be measured later.
  const noteSourceSighting = (jobKey, source, company, seenAt) => {
    const [kind] = sourceKinds(source ? [source] : []);
    if (kind) insertSourceSighting.run(jobKey, kind, String(company || '').trim().slice(0, 200) || null, Number(seenAt));
  };

  // A duplicate row keeps only its URL and identity key; company+role matches
  // always land on the representative.
  const findByIdentity = db.prepare(`
    SELECT * FROM jobs
    WHERE canonical_url = @canonicalUrl
       OR (@companyRoleKey <> '::' AND company_role_key = @companyRoleKey AND duplicate_of IS NULL)
    ORDER BY canonical_url = @canonicalUrl DESC
    LIMIT 1
  `);

  // ---- Job identity dedup ----------------------------------------------
  // One company + one role = one job, whatever source or URL it came from.
  // Extra postings become duplicate_of rows: technical identity only, never
  // scored, never shown, their sources credited to the representative.

  const getJobRow = db.prepare('SELECT * FROM jobs WHERE job_key = ?');
  const findTwinRow = db.prepare(`
    SELECT * FROM jobs
    WHERE company_role_key = ? AND job_key <> ? AND duplicate_of IS NULL
    ORDER BY archived_at IS NOT NULL DESC,
      (evaluated_at IS NOT NULL AND last_error_code IS NULL) DESC,
      first_seen_at ASC
    LIMIT 1
  `);

  const representativeOf = (row) => {
    let current = row;
    for (let hops = 0; current?.duplicate_of && hops < 10; hops += 1) {
      const next = getJobRow.get(current.duplicate_of);
      if (!next) break;
      current = next;
    }
    return current;
  };

  // Whether a twin's existing verdict settles the job for this evaluation
  // context. A local verdict (no profile hash) defers to any real decision.
  const isSettled = (row, { profileHash = null, criteriaVersion = null } = {}) => {
    if (row.archived_at) return true;
    if (!row.evaluated_at || row.last_error_code) return false;
    if (!profileHash || !row.profile_hash) return true;
    return row.profile_hash === profileHash && row.criteria_version === criteriaVersion;
  };

  const markDuplicateRow = db.transaction((duplicateKey, representativeKey, at) => {
    const duplicate = getJobRow.get(duplicateKey);
    const representative = representativeOf(getJobRow.get(representativeKey));
    if (!duplicate || !representative || representative.job_key === duplicate.job_key) return null;
    const repKey = representative.job_key;

    const representativeIsLive = !representative.archived_at &&
      (!representative.evaluated_at || representative.suitable);
    if (representativeIsLive) {
      const sources = new Set([...parseSources(representative.sources_json), ...parseSources(duplicate.sources_json)]);
      db.prepare('UPDATE jobs SET sources_json = ?, last_seen_at = MAX(last_seen_at, ?) WHERE job_key = ?')
        .run(JSON.stringify([...sources]), duplicate.last_seen_at, repKey);
    } else {
      db.prepare('UPDATE jobs SET last_seen_at = MAX(last_seen_at, ?) WHERE job_key = ?').run(duplicate.last_seen_at, repKey);
    }
    db.prepare('UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ?').run(repKey, duplicate.job_key);
    db.prepare(`
      INSERT INTO job_source_sightings (job_key, source_kind, company, first_seen_at)
      SELECT ?, source_kind, company, first_seen_at FROM job_source_sightings WHERE job_key = ?
      ON CONFLICT(job_key, source_kind) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)
    `).run(repKey, duplicate.job_key);
    db.prepare('DELETE FROM job_source_sightings WHERE job_key = ?').run(duplicate.job_key);
    db.prepare('UPDATE OR IGNORE job_decisions SET job_key = ? WHERE job_key = ?').run(repKey, duplicate.job_key);
    db.prepare('DELETE FROM job_decisions WHERE job_key = ?').run(duplicate.job_key);
    db.prepare(`
      UPDATE jobs SET
        duplicate_of = @repKey,
        possible_duplicate_of = NULL,
        company = NULL,
        title = NULL,
        summary = NULL,
        score = NULL,
        fit_label = NULL,
        decision_reason = NULL,
        fit_breakdown_json = NULL,
        resume_gap_json = NULL,
        resume_gap_input_hash = NULL,
        resume_gap_analyzed_at = NULL,
        resume_gap_error_code = NULL,
        resume_gap_error_reason = NULL,
        resume_gap_last_attempted_at = NULL,
        suitable = 0,
        apply_url = canonical_url,
        sources_json = '[]',
        evaluated_at = COALESCE(evaluated_at, @at),
        last_error_code = NULL,
        last_error_reason = NULL
      WHERE job_key = @jobKey
    `).run({ repKey, at, jobKey: duplicate.job_key });
    db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(duplicate.canonical_url);
    db.prepare('UPDATE linkedin_postings SET external_canonical_url = NULL WHERE job_key = ?').run(duplicate.job_key);
    return repKey;
  });

  // Groups of rows sharing a real company+role key, with the row that should
  // represent each group first. Key recomputation covers rows written before
  // the current normalization (rejected rows keep only the key itself).
  const planIdentityDedup = () => {
    const rekeys = [];
    for (const row of db.prepare('SELECT job_key, company, title, company_role_key FROM jobs').all()) {
      const [keyCompany = '', keyTitle = ''] = String(row.company_role_key || '').split('::');
      const key = normalizeCompanyRole(row.company || keyCompany, row.title || keyTitle);
      if (key !== row.company_role_key) rekeys.push({ jobKey: row.job_key, from: row.company_role_key, to: key });
    }
    const keyOf = new Map(rekeys.map(({ jobKey, to }) => [jobKey, to]));
    const byKey = new Map();
    for (const row of db.prepare(`
      SELECT j.*, d.job_key IS NOT NULL AS has_decision
      FROM jobs j LEFT JOIN job_decisions d ON d.job_key = j.job_key
      WHERE j.duplicate_of IS NULL
    `).all()) {
      const key = keyOf.get(row.job_key) ?? row.company_role_key;
      if (!key || key === '::') continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    const rank = (row) => [
      row.has_decision ? 0 : 1,
      row.archived_at ? 0 : 1,
      row.suitable && row.active_status === 'active' && row.evaluated_at ? 0 : 1,
      row.evaluated_at && !row.last_error_code ? 0 : 1,
      row.first_seen_at,
    ];
    const compare = (left, right) => {
      const a = rank(left);
      const b = rank(right);
      for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
      return 0;
    };
    const groups = [...byKey.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => {
        const [representative, ...duplicates] = [...rows].sort(compare);
        return { key, representative, duplicates };
      })
      .sort((left, right) => right.duplicates.length - left.duplicates.length || left.key.localeCompare(right.key));
    return { rekeys, groups };
  };

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
      const discoverySource = sources.some((source) => /^whatsapp:/i.test(source)) ? 'whatsapp'
        : sources.some((source) => /^linkedin:/i.test(source)) ? 'linkedin' : 'ats';
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

    // Guarantees a company ends up in 'candidate' — used when a person
    // explicitly flags a company as worth tracking (e.g. "בדוק חברה למעקב"
    // on the Decisions page), regardless of whatever status it happened to
    // have before: brand new, previously ignored, or previously paused.
    // Unlike upsertCompanyCandidate (which never touches an existing row's
    // status), this always lands the company where the person asked for it
    // to go. A company already watched is left alone — there's nothing to
    // move for a company already being tracked.
    markCompanyAsCandidate(id, at = Date.now()) {
      const normalizedId = companyId(id);
      const company = getCompanySnapshot(normalizedId);
      if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      if (company.status !== 'watched' && company.status !== 'candidate') {
        this.setCompanyStatus(normalizedId, 'candidate', at);
        return getCompanySnapshot(normalizedId);
      }
      return company;
    },

    // One-time repair for companies that importConfiguredCompanies previously
    // (incorrectly) forced to 'paused' just because their source wasn't
    // resolvable yet — before the fix above, that was indistinguishable from
    // the user deliberately pausing a company. Only touches rows matching
    // that exact, narrow signature, so a company the user genuinely paused
    // (any other discovery_source or resolution_status) is left untouched.
    // Safe to run more than once: nothing left to reclassify is a no-op.
    reclassifyAutoPausedCompanies(at = Date.now()) {
      const rows = db.prepare(`
        SELECT id, name FROM companies
        WHERE status = 'paused' AND discovery_source = 'configured' AND resolution_status = 'unsupported'
      `).all();
      for (const row of rows) this.setCompanyStatus(row.id, 'candidate', at);
      return { reclassified: rows.map((row) => row.name) };
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
          // A source that wasn't enabled/resolvable is the scanner's problem,
          // not a choice the user made — it belongs in 'candidate' (awaiting
          // a working source), never 'paused' (which means the user
          // deliberately doesn't want this company tracked, e.g. via the
          // "השהה" button). This block only ever revisits a company the sync
          // itself previously placed in 'candidate' for this exact reason, so
          // it never overwrites a status the user picked themselves.
          const autoCandidateUnsupportedUpgrade = preexisting?.status === 'candidate' &&
            preexisting?.resolution_status === 'unsupported' &&
            preexisting?.discovery_source === 'configured';
          if (!preexisting || autoCandidateUnsupportedUpgrade) {
            if (candidate.source?.enabled && entry?.enabled !== false) this.approveCompany(saved.company.id, at);
            else this.setCompanyStatus(saved.company.id, 'candidate', at);
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

    // ---- Notifications ----------------------------------------------------

    enqueueJobNotification({ jobKey, text, at = Date.now() }) {
      return db.prepare(`
        INSERT INTO notification_outbox (job_key, text, created_at) VALUES (?, ?, ?)
        ON CONFLICT(job_key) DO NOTHING
      `).run(String(jobKey), String(text).slice(0, 2_000), Number(at)).changes === 1;
    },

    // Unsent, still-fresh notifications that have not exhausted their attempts.
    listPendingNotifications({ now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, maxAttempts = 5, limit = 10 } = {}) {
      return db.prepare(`
        SELECT id, job_key AS jobKey, text, attempts FROM notification_outbox
        WHERE sent_at IS NULL AND attempts < ? AND created_at >= ?
        ORDER BY created_at ASC LIMIT ?
      `).all(Number(maxAttempts), Number(now) - Number(maxAgeMs), Math.max(1, Math.min(Number(limit) || 10, 50)));
    },

    markNotificationSent(id, at = Date.now()) {
      db.prepare('UPDATE notification_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?')
        .run(Number(at), Number(id));
    },

    markNotificationFailed(id, error) {
      db.prepare('UPDATE notification_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?')
        .run(String(error || 'unknown').slice(0, 300), Number(id));
    },

    // "Interested" in a job means its company is worth watching: it lands as a
    // candidate for one-click approval on the companies page (never demoting
    // a watched one). Best effort — a job without a usable company is skipped.
    suggestCompanyForJob(jobKey, at = Date.now()) {
      try {
        const saved = this.upsertCompanyCandidate(this.resolveCompanyCandidateForJob(jobKey), at);
        return this.markCompanyAsCandidate(saved.company.id, at);
      } catch {
        return null;
      }
    },

    // Per-company ATS progress: when each company's enabled sources were last
    // scanned successfully (the oldest one if they differ; null if never).
    // Keyed by normalized company identity, like recordCompanyScanResults.
    getCompanyLastSuccessTimes() {
      const rows = db.prepare(`
        SELECT c.name, MIN(s.last_success_at) AS lastSuccessAt, COUNT(s.last_success_at) AS succeeded, COUNT(*) AS total
        FROM company_job_sources s
        JOIN companies c ON c.id = s.company_id
        WHERE s.enabled = 1 AND s.provider <> 'unsupported'
        GROUP BY c.id
      `).all();
      return new Map(rows.map((row) => [
        normalizeCompanyIdentity(row.name),
        row.succeeded === row.total ? Number(row.lastSuccessAt) : null,
      ]));
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

    // Same URL, or same company + role from any source, is the same job.
    recordSighting({ url, company = '', title = '', source, seenAt = Date.now() }) {
      const canonicalUrl = canonicalizeJobUrl(url);
      if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);
      const companyRoleKey = normalizeCompanyRole(company, title);
      const existing = representativeOf(findByIdentity.get({ canonicalUrl, companyRoleKey }));

      if (existing) {
        if (existing.archived_at || (existing.evaluated_at && !existing.suitable)) {
          db.prepare('UPDATE jobs SET last_seen_at = ? WHERE job_key = ?').run(seenAt, existing.job_key);
          noteSourceSighting(existing.job_key, source, company, seenAt);
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
        noteSourceSighting(existing.job_key, source, company, seenAt);
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
        url: canonicalUrl.startsWith('https://www.linkedin.com/jobs/view/') ? canonicalUrl : url,
        companyRoleKey,
        company,
        title,
        sources: JSON.stringify(source ? [source] : []),
        seenAt,
      });
      noteSourceSighting(jobKey, source, company, seenAt);
      return { jobKey, canonicalUrl, isNew: true };
    },

    // ---- Codex usage and quota ------------------------------------------

    recordCodexCall(entry = {}) {
      const at = Number(entry.at) || Date.now();
      const usage = entry.usage || {};
      const int = (value) => (value != null && Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
      db.prepare(`
        INSERT INTO codex_calls (run_id, purpose, model, reasoning_effort, items, input_tokens, cached_input_tokens,
          output_tokens, reasoning_tokens, duration_ms, ok, error_code, created_at, source_mix)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        int(entry.runId), String(entry.purpose || 'other').slice(0, 32), entry.model ? String(entry.model).slice(0, 64) : null,
        entry.reasoningEffort ? String(entry.reasoningEffort).slice(0, 16) : null, int(entry.items),
        entry.usage ? int(usage.inputTokens) : null, entry.usage ? int(usage.cachedInputTokens) : null,
        entry.usage ? int(usage.outputTokens) : null, entry.usage ? int(usage.reasoningTokens) : null,
        int(entry.durationMs), entry.ok ? 1 : 0, entry.errorCode ? String(entry.errorCode).slice(0, 64) : null, at,
        normalizeSourceMix(entry.sourceMix),
      );
      if (entry.ok) this.noteLlmSuccess(at);
      else if (entry.errorCode === 'codex_usage_limit' && entry.limitUntil) {
        this.setLlmBlocked({ until: entry.limitUntil, reason: 'usage_limit', at });
      }
      db.prepare('DELETE FROM codex_calls WHERE created_at < ?').run(at - 90 * 24 * 60 * 60 * 1000);
    },

    recordSourceOutcome({ source, suitable, at = Date.now() }) {
      const kind = SOURCE_KINDS.has(source) ? source : 'other';
      db.prepare(`
        INSERT INTO source_daily_outcomes (day, source, scored, suitable) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, source) DO UPDATE SET scored = scored + 1, suitable = suitable + excluded.suitable
      `).run(israelDay(at), kind, suitable ? 1 : 0);
    },

    // Daily Codex tokens per source. A call's tokens are split equally among
    // the jobs in its batch (every job shares the batch's fixed prompt, and
    // page text is capped at a similar length). Calls tied to no job (quota
    // probe, company research) are "system"; calls recorded before source
    // attribution existed are "unclassified".
    dailyUsageBySource({ days = 14, now = Date.now() } = {}) {
      const boundedDays = Math.max(1, Math.min(60, Number(days) || 14));
      const dayKeys = Array.from({ length: boundedDays }, (_, index) => israelDay(now - index * 24 * 60 * 60 * 1000));
      const sinceMs = now - (boundedDays + 1) * 24 * 60 * 60 * 1000;
      const rows = new Map();
      const rowFor = (day, source) => {
        const key = `${day}|${source}`;
        if (!rows.has(key)) rows.set(key, { day, source, tokens: 0, calls: 0, items: 0, scored: 0, suitable: 0, limited: 0 });
        return rows.get(key);
      };
      const calls = db.prepare(`
        SELECT purpose, items, input_tokens, output_tokens, ok, error_code, created_at, source_mix
        FROM codex_calls WHERE created_at >= ?
      `).all(sinceMs);
      const wanted = new Set(dayKeys);
      for (const call of calls) {
        const day = israelDay(call.created_at);
        if (!wanted.has(day)) continue;
        const tokens = Number(call.input_tokens || 0) + Number(call.output_tokens || 0);
        const mix = parseJson(call.source_mix, null);
        const shares = mix && Object.values(mix).some((count) => count > 0)
          ? Object.entries(mix).filter(([, count]) => count > 0)
          : [[['probe', 'company_research'].includes(call.purpose) ? 'system' : 'unclassified', 1]];
        const total = shares.reduce((sum, [, count]) => sum + Number(count), 0);
        for (const [source, count] of shares) {
          const row = rowFor(day, source);
          row.tokens += tokens * (Number(count) / total);
          row.calls += Number(count) / total;
          if (call.error_code === 'codex_usage_limit') row.limited += Number(count) / total;
        }
      }
      for (const outcome of db.prepare('SELECT * FROM source_daily_outcomes WHERE day IN (' + dayKeys.map(() => '?').join(',') + ')').all(...dayKeys)) {
        const row = rowFor(outcome.day, outcome.source);
        row.scored += Number(outcome.scored || 0);
        row.suitable += Number(outcome.suitable || 0);
      }
      const list = [...rows.values()].map((row) => ({
        ...row,
        tokens: Math.round(row.tokens),
        calls: Math.round(row.calls * 10) / 10,
        limited: Math.round(row.limited * 10) / 10,
        tokensPerSuitable: row.suitable ? Math.round(row.tokens / row.suitable) : null,
      }));
      return { days: dayKeys, rows: list.sort((a, b) => b.day.localeCompare(a.day) || a.source.localeCompare(b.source)) };
    },

    getLlmQuota() {
      const row = db.prepare('SELECT * FROM llm_state WHERE id = 1').get();
      return {
        blockedUntil: row?.blocked_until ?? null,
        blockedReason: row?.blocked_reason ?? null,
        blockedAt: row?.blocked_at ?? null,
        lastSuccessAt: row?.last_success_at ?? null,
        lastSkipAt: row?.last_skip_at ?? null,
      };
    },

    setLlmBlocked({ until, reason = 'usage_limit', at = Date.now() }) {
      db.prepare(`
        INSERT INTO llm_state (id, blocked_until, blocked_reason, blocked_at, updated_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET blocked_until = MAX(COALESCE(blocked_until, 0), excluded.blocked_until),
          blocked_reason = excluded.blocked_reason, blocked_at = excluded.blocked_at, updated_at = excluded.updated_at
      `).run(Number(until), String(reason).slice(0, 64), Number(at), Number(at));
    },

    noteLlmSuccess(at = Date.now()) {
      db.prepare(`
        INSERT INTO llm_state (id, last_success_at, blocked_until, updated_at) VALUES (1, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET last_success_at = excluded.last_success_at, blocked_until = NULL,
          blocked_reason = NULL, updated_at = excluded.updated_at
      `).run(Number(at), Number(at));
    },

    noteLlmSkip(at = Date.now()) {
      db.prepare(`
        INSERT INTO llm_state (id, last_skip_at, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_skip_at = excluded.last_skip_at, updated_at = excluded.updated_at
      `).run(Number(at), Number(at));
    },

    // Totals per purpose over a window, plus per-run rows for the latest runs.
    summarizeCodexUsage({ sinceMs = 0, untilMs = Date.now(), recentRuns = 8 } = {}) {
      const totals = db.prepare(`
        SELECT purpose,
          COUNT(*) AS calls, SUM(ok) AS ok_calls, SUM(CASE WHEN error_code = 'codex_usage_limit' THEN 1 ELSE 0 END) AS limited,
          COALESCE(SUM(items), 0) AS items,
          COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_calls,
          GROUP_CONCAT(DISTINCT model) AS models
        FROM codex_calls WHERE created_at >= ? AND created_at <= ?
        GROUP BY purpose ORDER BY purpose
      `).all(Number(sinceMs), Number(untilMs)).map((row) => ({
        purpose: row.purpose, calls: row.calls, okCalls: row.ok_calls, limited: row.limited, items: row.items,
        inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens, outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens, measuredCalls: row.measured_calls,
        models: row.models ? row.models.split(',') : [],
      }));
      const runs = db.prepare(`
        SELECT c.run_id AS runId, MIN(c.created_at) AS startedAt, COUNT(*) AS calls, COALESCE(SUM(c.items), 0) AS items,
          COALESCE(SUM(c.input_tokens), 0) + COALESCE(SUM(c.output_tokens), 0) AS totalTokens,
          COALESCE(SUM(c.cached_input_tokens), 0) AS cachedInputTokens,
          SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS failedCalls,
          r.sources AS sources
        FROM codex_calls c LEFT JOIN runs r ON r.id = c.run_id
        WHERE c.run_id IS NOT NULL
        GROUP BY c.run_id ORDER BY c.run_id DESC LIMIT ?
      `).all(Math.max(1, Math.min(50, Number(recentRuns) || 8))).map((row) => ({ ...row, sources: parseSources(row.sources) }));
      return { totals, runs, quota: this.getLlmQuota() };
    },

    isKnownJobUrl(canonicalUrl) {
      return Boolean(db.prepare('SELECT 1 FROM jobs WHERE canonical_url = ?').get(String(canonicalUrl)));
    },

    // Called once a job's real company and title are known (after the page
    // fetch, before scoring). A twin that is already decided, or already
    // queued in this run, makes this job a duplicate so it is never scored.
    // Otherwise the identity is stored so later sightings match it directly.
    claimJobIdentity(jobKey, { company, title, profileHash = null, criteriaVersion = null, at = Date.now() }) {
      const job = getJobRow.get(String(jobKey));
      if (!job || job.duplicate_of) return { duplicateOf: job?.duplicate_of ?? null };
      const key = normalizeCompanyRole(company, title);
      if (key === '::') return { duplicateOf: null };
      const twin = findTwinRow.get(key, job.job_key);
      const twinIsQueued = twin && !twin.evaluated_at && !twin.last_error_code;
      if (twin && (twinIsQueued || isSettled(twin, { profileHash, criteriaVersion }))) {
        return { duplicateOf: markDuplicateRow(job.job_key, twin.job_key, at) };
      }
      db.prepare(`
        UPDATE jobs SET company_role_key = ?, company = COALESCE(NULLIF(company, ''), ?), title = COALESCE(NULLIF(title, ''), ?)
        WHERE job_key = ?
      `).run(key, String(company), String(title), job.job_key);
      return { duplicateOf: null };
    },

    // Exact evidence (e.g. a LinkedIn posting whose apply URL is a known job).
    markDuplicate(duplicateKey, representativeKey, at = Date.now()) {
      return markDuplicateRow(String(duplicateKey), String(representativeKey), at);
    },

    planIdentityDedup() {
      return planIdentityDedup();
    },

    // One-off cleanup of rows stored before cross-source dedup existed.
    applyIdentityDedup(at = Date.now()) {
      const { rekeys, groups } = planIdentityDedup();
      db.transaction(() => {
        const rekey = db.prepare('UPDATE jobs SET company_role_key = ? WHERE job_key = ?');
        for (const { jobKey, to } of rekeys) rekey.run(to, jobKey);
        for (const { representative, duplicates } of groups) {
          for (const duplicate of duplicates) markDuplicateRow(duplicate.job_key, representative.job_key, at);
        }
      })();
      return { rekeyed: rekeys.length, groups: groups.length, duplicates: groups.reduce((sum, group) => sum + group.duplicates.length, 0) };
    },

    getJob(jobKey) {
      return db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(jobKey) ?? null;
    },

    countJobs() {
      return db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
    },

    // excludeErrorCodes lets a caller skip failures classified as not worth
    // retrying (e.g. a site-level anti-bot block) — a job that never got a
    // real error (evaluated_at IS NULL, last_error_code IS NULL) is always
    // included regardless, since that's a brand-new candidate, not a stuck
    // failure.
    listPendingEvaluation({ limit = 5_000, excludeErrorCodes = [] } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 5_000, 10_000));
      const codes = Array.isArray(excludeErrorCodes) ? excludeErrorCodes.filter(Boolean) : [];
      const excludeClause = codes.length
        ? `AND (last_error_code IS NULL OR last_error_code NOT IN (${codes.map(() => '?').join(', ')}))`
        : '';
      return db.prepare(`
        SELECT
          job_key AS jobKey,
          canonical_url AS canonicalUrl,
          apply_url AS url,
          company,
          title,
          sources_json AS sourcesJson,
          (SELECT source_kind FROM job_source_sightings s WHERE s.job_key = jobs.job_key
            ORDER BY s.first_seen_at DESC LIMIT 1) AS sightingKind
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND (evaluated_at IS NULL OR last_error_code IS NOT NULL)
          ${excludeClause}
        ORDER BY first_seen_at ASC
        LIMIT ?
      `).all(...codes, boundedLimit).map(({ sourcesJson, sightingKind, ...job }) => ({
        ...job,
        // A rejected job keeps no sources_json, so a failed re-check of it
        // falls back to its latest sighting; otherwise no per-source run
        // would ever retry it.
        source: parseSources(sourcesJson)[0] || SIGHTING_RETRY_SOURCES[sightingKind] || 'retry',
      }));
    },

    getDashboardStats() {
      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN archived_at IS NULL AND duplicate_of IS NULL THEN 1 ELSE 0 END) AS total,
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

    listDashboardJobs({ resumeGapContext = null } = {}) {
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
          content_hash AS contentHash,
          profile_hash AS profileHash,
          resume_gap_json AS resumeGapJson,
          resume_gap_input_hash AS resumeGapInputHash,
          resume_gap_analyzed_at AS resumeGapAnalyzedAt,
          resume_gap_error_code AS resumeGapErrorCode,
          resume_gap_error_reason AS resumeGapErrorReason,
          last_seen_at AS lastSeenAt,
          opened_at AS openedAt,
          sources_json AS sourcesJson
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND evaluated_at IS NOT NULL AND suitable = 1 AND active_status = 'active'
        ORDER BY last_seen_at DESC, score DESC
        LIMIT 500
      `).all().map((job) => {
        const expectedHash = resumeGapContext?.resumeAvailable
          ? resumeGapInputHash({
            contentHash: job.contentHash,
            profileHash: job.profileHash,
            resumeHash: resumeGapContext.resumeHash,
            analysisVersion: resumeGapContext.analysisVersion,
          })
          : null;
        const isCurrent = Boolean(expectedHash && job.resumeGapInputHash === expectedHash);
        const analysis = isCurrent ? parseJson(job.resumeGapJson, null) : null;
        const resumeGap = !resumeGapContext?.resumeAvailable
          ? { status: 'unavailable', items: [] }
          : analysis && Array.isArray(analysis.items)
            ? {
              status: 'ready',
              items: analysis.items,
              employerPriorities: Array.isArray(analysis.employerPriorities) ? analysis.employerPriorities : [],
              screenPass: analysis.screenPass ?? null,
              analyzedAt: job.resumeGapAnalyzedAt,
            }
            : isCurrent && job.resumeGapErrorCode
              ? {
                status: 'failed',
                items: [],
                code: job.resumeGapErrorCode,
                reason: job.resumeGapErrorReason || 'ניתוח קורות החיים נכשל.',
              }
              : { status: 'pending', items: [] };
        const hidden = new Set([
          'fitBreakdownJson', 'contentHash', 'profileHash', 'resumeGapJson',
          'resumeGapInputHash', 'resumeGapAnalyzedAt', 'resumeGapErrorCode', 'resumeGapErrorReason',
          'sourcesJson',
        ]);
        return {
          ...Object.fromEntries(Object.entries(job).filter(([key]) => !hidden.has(key))),
          sourceKinds: sourceKinds(parseSources(job.sourcesJson)),
          fitBreakdown: parseJson(job.fitBreakdownJson, null),
          resumeGap,
          suitable: Boolean(job.suitable),
        };
      });
    },

    listResumeGapCandidates({ limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 500));
      return db.prepare(`
        SELECT
          j.job_key AS jobKey,
          j.company,
          j.title,
          j.apply_url AS applyUrl,
          j.content_hash AS contentHash,
          j.profile_hash AS profileHash,
          j.resume_gap_input_hash AS storedResumeGapInputHash,
          j.resume_gap_error_code AS resumeGapErrorCode,
          j.sources_json AS sourcesJson,
          j.evaluated_at AS evaluatedAt,
          p.content
        FROM jobs j
        JOIN job_pages p ON p.canonical_url = j.canonical_url
        WHERE j.archived_at IS NULL AND j.duplicate_of IS NULL
          AND j.evaluated_at IS NOT NULL
          AND j.suitable = 1
          AND j.active_status = 'active'
        ORDER BY j.last_seen_at DESC, j.score DESC
        LIMIT ?
      `).all(boundedLimit);
    },

    saveResumeGap(jobKey, { inputHash, analysis, analyzedAt = Date.now() }) {
      const result = db.prepare(`
        UPDATE jobs SET
          resume_gap_json = ?,
          resume_gap_input_hash = ?,
          resume_gap_analyzed_at = ?,
          resume_gap_error_code = NULL,
          resume_gap_error_reason = NULL,
          resume_gap_last_attempted_at = ?
        WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
      `).run(JSON.stringify(analysis), inputHash, analyzedAt, analyzedAt, jobKey);
      if (result.changes !== 1) throw new Error(`Cannot save resume analysis for job: ${jobKey}`);
    },

    markResumeGapFailure(jobKey, { inputHash, code = 'resume_gap_failed', reason, attemptedAt = Date.now() }) {
      const safeReason = String(reason || 'Resume analysis failed.')
        .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const result = db.prepare(`
        UPDATE jobs SET
          resume_gap_json = NULL,
          resume_gap_input_hash = ?,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = ?,
          resume_gap_error_reason = ?,
          resume_gap_last_attempted_at = ?
        WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
      `).run(inputHash, String(code).slice(0, 64), safeReason, attemptedAt, jobKey);
      if (result.changes !== 1) throw new Error(`Cannot record resume analysis failure for job: ${jobKey}`);
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
          first_scored_at = CASE WHEN @scoredByModel = 1 THEN COALESCE(first_scored_at, @evaluatedAt) ELSE first_scored_at END,
          first_suitable_at = CASE WHEN @suitable = 1 THEN COALESCE(first_suitable_at, @evaluatedAt) ELSE first_suitable_at END,
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
        // Only a real model call counts as scoring cost; local filters and
        // dead-link verdicts also land here and must not inflate it.
        scoredByModel: evaluation.scoredByModel === true ? 1 : 0,
        applyUrl: suitable ? evaluation.applyUrl : existing.canonical_url,
        sources: suitable ? existing.sources_json : '[]',
        jobKey,
      });
      if (!suitable) {
        db.prepare(`
          UPDATE jobs SET
            resume_gap_json = NULL,
            resume_gap_input_hash = NULL,
            resume_gap_analyzed_at = NULL,
            resume_gap_error_code = NULL,
            resume_gap_error_reason = NULL,
            resume_gap_last_attempted_at = NULL
          WHERE job_key = ?
        `).run(jobKey);
        db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(existing.canonical_url);
        db.prepare('UPDATE linkedin_postings SET external_canonical_url = NULL WHERE job_key = ?').run(jobKey);
      }

      // Scoring can reveal an identity that matches another job. A twin whose
      // verdict still holds wins; a stale or pending twin yields to this fresh
      // verdict — unless this one is a dead link, which never hides a live twin.
      const key = normalizeCompanyRole(evaluation.company, evaluation.title);
      const twin = key === '::' ? null : findTwinRow.get(key, jobKey);
      if (twin) {
        const context = { profileHash: evaluation.profileHash, criteriaVersion: evaluation.criteriaVersion };
        const thisIsDead = evaluation.activeStatus && evaluation.activeStatus !== 'active' && evaluation.activeStatus !== 'unknown';
        if (thisIsDead || isSettled(twin, context)) markDuplicateRow(jobKey, twin.job_key, evaluation.evaluatedAt ?? Date.now());
        else markDuplicateRow(twin.job_key, jobKey, evaluation.evaluatedAt ?? Date.now());
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
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND suitable = 1 AND presented_at IS NULL AND active_status = 'active'
        ORDER BY score DESC, first_seen_at ASC
      `).all();
    },

    listUnopenedSuitable() {
      return db.prepare(`
        SELECT job_key AS jobKey, company, title, apply_url AS applyUrl
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
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

    // Records what the user did with a shown job, then archives it in the
    // same transaction: the decision row keeps only the small snapshot the
    // statistics need (never page text), and archiveJob wipes the rest.
    decideJob(jobKey, decision, at = Date.now()) {
      if (!JOB_DECISIONS.has(decision)) {
        throw Object.assign(new Error(`Unknown decision: ${decision}`), { statusCode: 400 });
      }
      return db.transaction(() => {
        const job = db.prepare(`
          SELECT * FROM jobs WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
        `).get(jobKey);
        if (!job) return false;
        const breakdown = parseJson(job.fit_breakdown_json, null);
        const fit = breakdown
          ? Object.fromEntries(FIT_DIMENSION_KEYS.filter((key) => breakdown[key] != null).map((key) => [key, Number(breakdown[key])]))
          : null;
        const screenPass = parseJson(job.resume_gap_json, null)?.screenPass?.level ?? null;
        db.prepare(`
          INSERT OR REPLACE INTO job_decisions (
            job_key, decision, decided_at, company, title, apply_url, score, fit_label,
            fit_json, source_kinds_json, screen_pass, criteria_version, first_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          jobKey, decision, at, job.company, job.title, job.apply_url, job.score, job.fit_label,
          fit ? JSON.stringify(fit) : null,
          JSON.stringify(sourceKinds(parseSources(job.sources_json))),
          screenPass, job.criteria_version, job.first_seen_at,
        );
        const companyKey = decision === 'company_not_interesting' ? companyIdentityKey(job.company) : '';
        if (companyKey) {
          db.prepare('INSERT OR IGNORE INTO blocked_companies (company_key, name, blocked_at) VALUES (?, ?, ?)')
            .run(companyKey, String(job.company).slice(0, 200), at);
        }
        if (!this.archiveJob(jobKey, at)) throw new Error(`Cannot archive decided job: ${jobKey}`);
        return true;
      })();
    },

    recordSourceScanStats(rows, { runId = null, at = Date.now() } = {}) {
      const insert = db.prepare(`
        INSERT INTO source_scan_stats (
          run_id, scanned_at, source_kind, seconds, found, filtered_title, filtered_location,
          filtered_recency, candidates, scored, suitable, failed, errors
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const count = (value) => Math.max(0, Math.trunc(Number(value) || 0));
      db.transaction(() => {
        for (const row of rows) {
          if (!['ats', 'whatsapp', 'linkedin'].includes(row.source)) continue;
          insert.run(
            runId, Number(at), row.source, Number.isFinite(row.seconds) ? row.seconds : null,
            count(row.found), count(row.filteredTitle), count(row.filteredLocation), count(row.filteredRecency),
            count(row.candidates), count(row.scored), count(row.suitable), count(row.failed), count(row.errors),
          );
        }
      })();
    },

    // Raw facts behind the source-value metrics (scripts/jobs/source-value.mjs).
    listSourceValueFacts({ since = 0 } = {}) {
      const from = Number(since) || 0;
      return {
        scans: db.prepare(`
          SELECT scanned_at AS scannedAt, source_kind AS source, seconds, found,
            filtered_title AS filteredTitle, filtered_location AS filteredLocation,
            filtered_recency AS filteredRecency, candidates, scored, suitable, failed, errors
          FROM source_scan_stats WHERE scanned_at >= ? ORDER BY scanned_at
        `).all(from),
        sightings: db.prepare(`
          SELECT s.job_key AS jobKey, s.source_kind AS source, s.company, s.first_seen_at AS firstSeenAt,
            j.first_scored_at AS firstScoredAt, j.first_suitable_at AS firstSuitableAt, d.decision
          FROM job_source_sightings s
          LEFT JOIN jobs j ON j.job_key = s.job_key
          LEFT JOIN job_decisions d ON d.job_key = s.job_key
          WHERE s.first_seen_at >= ? OR j.first_suitable_at >= ?
        `).all(from, from),
        watchedCompanies: db.prepare("SELECT name FROM companies WHERE status = 'watched' ORDER BY name COLLATE NOCASE")
          .all().map((row) => row.name),
      };
    },

    listJobDecisions({ since = 0 } = {}) {
      return db.prepare('SELECT * FROM job_decisions WHERE decided_at >= ? ORDER BY decided_at DESC')
        .all(Number(since) || 0).map(mapJobDecision);
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
          resume_gap_json = NULL,
          resume_gap_input_hash = NULL,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = NULL,
          resume_gap_error_reason = NULL,
          resume_gap_last_attempted_at = NULL,
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

    // A reliable "what's failing right now" view — independent of any one
    // run, since a stuck failure keeps re-appearing across runs until it's
    // fixed, retried successfully, or archived.
    getFailureBreakdown() {
      return db.prepare(`
        SELECT last_error_code AS code, COUNT(*) AS count
        FROM jobs
        WHERE archived_at IS NULL AND last_error_code IS NOT NULL
        GROUP BY last_error_code
        ORDER BY count DESC, last_error_code ASC
      `).all();
    },

    // Bulk version of archiveJob for "clear every failure of this kind" —
    // same field-nulling as a single archive, just scoped by error code
    // instead of by job key. A no-op (never a malformed `IN ()`) on an
    // empty code list.
    archiveJobsByErrorCode(codes, at = Date.now()) {
      const safeCodes = Array.isArray(codes) ? codes.filter(Boolean) : [];
      if (safeCodes.length === 0) return { archived: 0 };
      const result = db.prepare(`
        UPDATE jobs SET
          company = NULL,
          title = NULL,
          summary = NULL,
          score = NULL,
          fit_label = NULL,
          decision_reason = NULL,
          fit_breakdown_json = NULL,
          resume_gap_json = NULL,
          resume_gap_input_hash = NULL,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = NULL,
          resume_gap_error_reason = NULL,
          resume_gap_last_attempted_at = NULL,
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
        WHERE archived_at IS NULL AND last_error_code IN (${safeCodes.map(() => '?').join(', ')})
      `).run(at, ...safeCodes);
      return { archived: result.changes };
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

    markWhatsAppMessagesRead(keys, { readAt = Date.now() } = {}) {
      if (!Array.isArray(keys) || keys.length > 5_000) {
        throw new Error('WhatsApp read keys must be an array of at most 5,000 items');
      }
      const timestamp = Number(readAt);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error('WhatsApp read timestamp must be a non-negative integer');
      }
      const update = db.prepare(`
        UPDATE processed_messages SET read_at = ?, updated_at = ?
        WHERE message_id = ? AND group_jid = ?
      `);
      return db.transaction((items) => {
        let marked = 0;
        for (const key of items) {
          if (typeof key?.id !== 'string' || !key.id || key.id.length > 256 ||
              typeof key?.remoteJid !== 'string' || !key.remoteJid || key.remoteJid.length > 128) continue;
          marked += update.run(timestamp, timestamp, key.id, key.remoteJid).changes;
        }
        return marked;
      })(keys);
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
          MAX(CASE WHEN status = 'done' THEN wa_timestamp END) AS last_processed_at,
          MAX(read_at) AS last_read_at,
          SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_total
        FROM processed_messages
        WHERE group_jid = ?
      `).get(groupJid);
      return {
        totalCollected: Number(row?.total_collected || 0),
        pending: Number(row?.pending || 0),
        failed: Number(row?.failed || 0),
        lastCollectedAt: row?.last_collected_at == null ? null : Number(row.last_collected_at),
        lastProcessedAt: row?.last_processed_at == null ? null : Number(row.last_processed_at),
        lastReadAt: row?.last_read_at == null ? null : Number(row.last_read_at),
        readTotal: Number(row?.read_total || 0),
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

    // windowStatus is the run's status judged without LinkedIn; it anchors
    // the next ATS/WhatsApp window even when only LinkedIn fell short.
    finishRun(runId, { status, error = null, details = null, failure = null, windowStatus = null, finishedAt = Date.now() }) {
      db.prepare('UPDATE runs SET finished_at = ?, status = ?, error = ?, details_json = COALESCE(?, details_json), diagnostic_json = ?, window_status = ? WHERE id = ?')
        .run(finishedAt, status, error ?? null, details ? JSON.stringify(details) : null, serializeAuditDetails(failure), windowStatus, runId);
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

    // Lightweight window query for rolling aggregates (per-group WhatsApp
    // stats, ATS-vs-WhatsApp cost comparisons): each finished run already
    // carries its own per-source, per-group breakdown in details_json
    // (see summarizeProcessingResults/summarizeSourceResults in jobs.mjs),
    // so summing across a time window needs no new event stream — just the
    // finished runs whose window it falls in. Unfinished runs are excluded:
    // their details_json may be a stale mid-run snapshot or absent.
    listRuns({ sinceMs, limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2_000));
      const rows = db.prepare(`
        SELECT id, started_at, finished_at, status, details_json FROM runs
        WHERE finished_at IS NOT NULL AND finished_at >= ?
        ORDER BY finished_at DESC
        LIMIT ?
      `).all(Number(sinceMs) || 0, boundedLimit);
      return rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        details: parseJson(row.details_json, null),
      }));
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
        const runs = db.prepare('SELECT id, sources, COALESCE(window_status, status) AS status FROM runs ORDER BY id DESC').all();
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
        SELECT * FROM runs WHERE COALESCE(window_status, status) = 'success' ORDER BY finished_at DESC
      `).all();
      // LinkedIn keeps its own per-search progress; it never anchors (or
      // holds back) the shared ATS/WhatsApp window.
      const required = requiredSources.filter((source) => source !== 'linkedin');
      return rows.find((row) => {
        const completedSources = new Set(parseSources(row.sources));
        return required.every((source) => completedSources.has(source));
      }) ?? null;
    },

    // ---- LinkedIn search source -------------------------------------------

    isSourceEnabled(source) {
      const row = db.prepare('SELECT enabled FROM source_settings WHERE source = ?').get(String(source));
      return row ? Boolean(row.enabled) : true;
    },

    setSourceEnabled(source, enabled, at = Date.now()) {
      db.prepare(`
        INSERT INTO source_settings (source, enabled, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
      `).run(String(source), enabled ? 1 : 0, at);
      return this.isSourceEnabled(source);
    },

    // config/jobs.yml is the only source of truth for LinkedIn searches.
    // Each search is matched by its key; a changed query gets a new query
    // hash (and so a fresh coverage history), and a search removed from the
    // config is disabled rather than deleted, keeping its history.
    syncLinkedInSearches(configured = [], at = Date.now()) {
      const searches = configured.map(normalizeLinkedInSearch);
      const keys = searches.map((search) => search.key);
      if (keys.some((key) => !key)) throw new Error('Every LinkedIn search in config/jobs.yml needs a key');
      if (new Set(keys).size !== keys.length) throw new Error('LinkedIn search keys in config/jobs.yml must be unique');
      const upsert = db.prepare(`
        INSERT INTO linkedin_searches (search_key, label, keywords, location, geo_id, enabled, origin, query_hash, created_at, updated_at)
        VALUES (@key, @label, @keywords, @location, @geoId, @enabled, 'config', @queryHash, @at, @at)
        ON CONFLICT(search_key) DO UPDATE SET
          label = excluded.label, keywords = excluded.keywords, location = excluded.location, geo_id = excluded.geo_id,
          enabled = excluded.enabled, origin = 'config', query_hash = excluded.query_hash,
          updated_at = CASE WHEN linkedin_searches.query_hash = excluded.query_hash AND linkedin_searches.label = excluded.label
            AND linkedin_searches.enabled = excluded.enabled THEN linkedin_searches.updated_at ELSE excluded.updated_at END
      `);
      const apply = db.transaction(() => {
        for (const search of searches) {
          upsert.run({ ...search, enabled: search.enabled ? 1 : 0, queryHash: linkedinQueryHash(search), at });
        }
        const placeholders = keys.map(() => '?').join(', ');
        db.prepare(`UPDATE linkedin_searches SET enabled = 0, updated_at = ? WHERE enabled = 1${keys.length ? ` AND search_key NOT IN (${placeholders})` : ''}`)
          .run(at, ...keys);
      });
      apply();
      return this.listLinkedInSearches();
    },

    listLinkedInSearches() {
      return db.prepare(`
        SELECT s.*, p.covered_until, p.last_success_at, p.last_attempt_at, p.last_status, p.last_reason,
               p.last_summary_json, p.gaps_json
        FROM linkedin_searches s
        LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.query_hash = s.query_hash
        ORDER BY s.id
      `).all().map(mapLinkedInSearch);
    },

    getLinkedInSearch(id) {
      const row = db.prepare(`
        SELECT s.*, p.covered_until, p.last_success_at, p.last_attempt_at, p.last_status, p.last_reason,
               p.last_summary_json, p.gaps_json
        FROM linkedin_searches s
        LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.query_hash = s.query_hash
        WHERE s.id = ?
      `).get(Number(id));
      return row ? mapLinkedInSearch(row) : null;
    },

    // Records one attempt. coveredUntil is only passed when the collection was
    // complete and saved; otherwise the stored coverage is left as it was.
    recordLinkedInSearchAttempt({ searchId, queryHash, status, reason = null, summary = null, coveredUntil = null, gap = null, attemptedAt = Date.now() }) {
      const previous = db.prepare('SELECT covered_until, gaps_json FROM linkedin_search_progress WHERE search_id = ? AND query_hash = ?')
        .get(Number(searchId), String(queryHash));
      const gaps = parseJson(previous?.gaps_json, []);
      if (gap) gaps.push(gap);
      const succeeded = coveredUntil != null;
      db.prepare(`
        INSERT INTO linkedin_search_progress (
          search_id, query_hash, covered_until, last_success_at, last_attempt_at, last_status, last_reason, last_summary_json, gaps_json
        ) VALUES (@searchId, @queryHash, @coveredUntil, @successAt, @attemptedAt, @status, @reason, @summary, @gaps)
        ON CONFLICT(search_id, query_hash) DO UPDATE SET
          covered_until = COALESCE(excluded.covered_until, covered_until),
          last_success_at = COALESCE(excluded.last_success_at, last_success_at),
          last_attempt_at = excluded.last_attempt_at,
          last_status = excluded.last_status,
          last_reason = excluded.last_reason,
          last_summary_json = excluded.last_summary_json,
          gaps_json = excluded.gaps_json
      `).run({
        searchId: Number(searchId),
        queryHash: String(queryHash),
        coveredUntil: succeeded ? Number(coveredUntil) : null,
        successAt: succeeded ? attemptedAt : null,
        attemptedAt,
        status: String(status).slice(0, 32),
        reason: reason == null ? null : String(reason).slice(0, 64),
        summary: summary ? serializeAuditDetails(summary) : null,
        gaps: gaps.length ? JSON.stringify(gaps.slice(-5)) : null,
      });
    },

    // postedAgeMs is the card's "N hours ago" lower bound; the first
    // sighting's estimate is kept, since later labels only get coarser.
    recordLinkedInPosting({ linkedinId, jobKey, listedAt = null, postedAgeMs = null, seenAt = Date.now() }) {
      const postedAt = Number.isFinite(postedAgeMs) ? seenAt - postedAgeMs : null;
      db.prepare(`
        INSERT INTO linkedin_postings (linkedin_id, job_key, listed_at, posted_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(linkedin_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, job_key = excluded.job_key,
          posted_at = COALESCE(linkedin_postings.posted_at, excluded.posted_at)
      `).run(String(linkedinId), String(jobKey), listedAt, postedAt, seenAt, seenAt);
    },

    listSightingTimes() {
      return db.prepare('SELECT job_key AS jobKey, source_kind AS sourceKind, first_seen_at AS firstSeenAt FROM job_source_sightings').all();
    },

    listLinkedInPostingTimes({ since = 0 } = {}) {
      return db.prepare(`
        SELECT posted_at AS postedAt, first_seen_at AS firstSeenAt FROM linkedin_postings
        WHERE posted_at IS NOT NULL AND first_seen_at >= ?
      `).all(Number(since) || 0);
    },

    linkedinPostedAt(linkedinId) {
      return db.prepare('SELECT posted_at FROM linkedin_postings WHERE linkedin_id = ?').get(String(linkedinId))?.posted_at ?? null;
    },

    // An external apply URL is exact evidence: when it names a job already
    // known from another source, that job is returned so callers can link.
    recordLinkedInExternalUrl(linkedinId, externalUrl) {
      const canonical = canonicalizeJobUrl(externalUrl);
      if (!canonical || linkedinJobIdFromCanonical(canonical)) return null;
      db.prepare('UPDATE linkedin_postings SET external_canonical_url = ? WHERE linkedin_id = ?').run(canonical, String(linkedinId));
      return db.prepare('SELECT job_key FROM jobs WHERE canonical_url = ?').get(canonical)?.job_key ?? null;
    },

    // ---- LinkedIn cooldown -------------------------------------------------

    noteLinkedInBlock(reason, { at = Date.now(), cooldownMs = 60 * 60 * 1000 } = {}) {
      db.prepare(`
        INSERT INTO linkedin_state (id, blocked_until, blocked_reason, blocked_at, last_activity_at)
        VALUES (1, @until, @reason, @at, @at)
        ON CONFLICT(id) DO UPDATE SET
          blocked_until = MAX(COALESCE(blocked_until, 0), @until),
          blocked_reason = @reason, blocked_at = @at,
          last_activity_at = MAX(COALESCE(last_activity_at, 0), @at)
      `).run({ until: Number(at) + Number(cooldownMs), reason: String(reason).slice(0, 32), at: Number(at) });
    },

    noteLinkedInActivity(at = Date.now()) {
      db.prepare(`
        INSERT INTO linkedin_state (id, last_activity_at) VALUES (1, @at)
        ON CONFLICT(id) DO UPDATE SET last_activity_at = MAX(COALESCE(last_activity_at, 0), @at)
      `).run({ at: Number(at) });
    },

    // A block stops every LinkedIn request; recent activity (another run's
    // searches or page reads) only spaces out page reads, so frequent
    // WhatsApp runs can never starve the scheduled LinkedIn scan.
    getLinkedInCooldown({ now = Date.now(), afterActivityMs = 15 * 60 * 1000 } = {}) {
      const row = db.prepare('SELECT * FROM linkedin_state WHERE id = 1').get();
      const block = row?.blocked_until > now ? { until: row.blocked_until, reason: row.blocked_reason || 'blocked' } : null;
      const activityUntil = row?.last_activity_at ? row.last_activity_at + Number(afterActivityMs) : 0;
      const reads = block || (activityUntil > now ? { until: activityUntil, reason: 'recent_activity' } : null);
      return { scans: block, reads };
    },

    isCompanyBlocked(company) {
      const key = companyIdentityKey(company);
      return Boolean(key && db.prepare('SELECT 1 FROM blocked_companies WHERE company_key = ?').get(key));
    },

    markDuplicateUrl(canonicalUrl, representativeKey, at = Date.now()) {
      const row = db.prepare('SELECT job_key FROM jobs WHERE canonical_url = ?').get(String(canonicalUrl));
      return row ? markDuplicateRow(row.job_key, String(representativeKey), at) : null;
    },

    getLinkedInPosting(linkedinId) {
      return db.prepare('SELECT * FROM linkedin_postings WHERE linkedin_id = ?').get(String(linkedinId)) ?? null;
    },

    listPersonalImprovements() {
      return db.prepare('SELECT * FROM personal_improvements ORDER BY position ASC, id ASC')
        .all().map(mapPersonalImprovement);
    },

    addPersonalImprovement(input, at = Date.now()) {
      const keyword = compactText(input?.keyword, 100);
      const explanation = compactText(input?.explanation, 280);
      const suggestion = compactText(input?.suggestion, 280);
      if (!keyword || !explanation || !suggestion) {
        throw Object.assign(new Error('keyword, explanation and suggestion are required'), { statusCode: 400 });
      }
      const kind = PERSONAL_IMPROVEMENT_KINDS.has(input?.kind) ? input.kind : 'needs_confirmation';
      const importance = PERSONAL_IMPROVEMENT_IMPORTANCE.has(input?.importance) ? input.importance : 'preferred';
      const sourceCompany = compactText(input?.sourceCompany, 200) || null;
      const sourceTitle = compactText(input?.sourceTitle, 200) || null;
      const sourceJobKey = compactText(input?.sourceJobKey, 64) || null;

      const existing = db.prepare(
        'SELECT * FROM personal_improvements WHERE keyword = ? AND source_job_key IS ?',
      ).get(keyword, sourceJobKey);
      if (existing) return { created: false, item: mapPersonalImprovement(existing) };

      const insert = db.transaction(() => {
        const nextPosition = (db.prepare('SELECT MAX(position) AS maxPosition FROM personal_improvements').get()?.maxPosition ?? -1) + 1;
        const result = db.prepare(`
          INSERT INTO personal_improvements (
            keyword, kind, importance, explanation, suggestion,
            source_company, source_title, source_job_key, position, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(keyword, kind, importance, explanation, suggestion, sourceCompany, sourceTitle, sourceJobKey, nextPosition, at);
        return db.prepare('SELECT * FROM personal_improvements WHERE id = ?').get(result.lastInsertRowid);
      });
      return { created: true, item: mapPersonalImprovement(insert()) };
    },

    removePersonalImprovement(id) {
      const result = db.prepare('DELETE FROM personal_improvements WHERE id = ?').run(Number(id));
      return result.changes > 0;
    },

    reorderPersonalImprovements(orderedIds) {
      const ids = (Array.isArray(orderedIds) ? orderedIds : []).map(Number).filter(Number.isInteger);
      const current = db.prepare('SELECT id FROM personal_improvements').all().map((row) => row.id);
      if (ids.length !== current.length || !current.every((id) => ids.includes(id))) {
        throw Object.assign(new Error('orderedIds must include every existing item exactly once'), { statusCode: 400 });
      }
      const update = db.prepare('UPDATE personal_improvements SET position = ? WHERE id = ?');
      db.transaction(() => {
        ids.forEach((id, index) => update.run(index, id));
      })();
      return this.listPersonalImprovements();
    },

    close() {
      db.close();
    },
  };
}
