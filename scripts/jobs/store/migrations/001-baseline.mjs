import { canonicalizeJobUrl } from '../../core.mjs';
import { DECISION_KEYS } from '../../decisions.mjs';
import { parseSources, sourceKinds } from '../shared.mjs';

const JOB_DECISION_COLUMNS = 'job_key, decision, decided_at, company, title, apply_url, score, fit_label, '
  + 'fit_json, source_kinds_json, screen_pass, criteria_version, first_seen_at';

// job_decisions is rebuilt (below) whenever this CHECK list grows.
function jobDecisionsTableSql(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      job_key TEXT PRIMARY KEY,
      decision TEXT NOT NULL
        CHECK(decision IN (${DECISION_KEYS.map((key) => `'${key}'`).join(', ')})),
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
    );`;
}

// Everything the store used to run on every open: creates the tables on a new
// database and brings any older one up to date, rows included. Idempotent, since
// it runs once on databases of every age.
export function up(db) {
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

    -- Legacy manual tracking list, replaced by gap_term_statuses. No code
    -- reads it any more; it is kept only so its rows are never lost.
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

    -- Durable copy of each suitable job's resume-gap analysis, so the
    -- personal area can aggregate gaps across jobs after they are decided
    -- and archived. Holds only the model's short gap terms and notes, never
    -- page text.
    CREATE TABLE IF NOT EXISTS gap_term_statuses (
      term_key TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'hidden')),
      updated_at INTEGER NOT NULL
    );

    -- Whether the current resume already covers an aggregated gap term in other
    -- words, judged by Codex once per resume (coverage_key = resume hash +
    -- check version). Only short terms are stored, never resume text.
    CREATE TABLE IF NOT EXISTS gap_term_coverage (
      coverage_key TEXT NOT NULL,
      term_key TEXT NOT NULL,
      covered INTEGER NOT NULL CHECK(covered IN (0, 1)),
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (coverage_key, term_key)
    );

    CREATE TABLE IF NOT EXISTS gap_observations (
      job_key TEXT PRIMARY KEY,
      company TEXT,
      title TEXT,
      score REAL,
      resume_hash TEXT,
      analysis_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );

    -- What the user did with a job shown on the Decisions page. Written in
    -- the same transaction that archives (and wipes) the job, so this is the
    -- only durable record of the job's content — kept small and local, for
    -- statistics and score calibration, never for re-scoring.
    ${jobDecisionsTableSql('job_decisions')}

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

    -- Every LinkedIn request from any process (search page or posting): the
    -- shared hourly cap counts it, and it shows what LinkedIn accepted.
    -- 14 days are kept.
    CREATE TABLE IF NOT EXISTS linkedin_requests (
      id   INTEGER PRIMARY KEY,
      at   INTEGER NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_linkedin_requests_at ON linkedin_requests(at);

    -- Where a HireMeTech listing really leads (scripts/jobs/hiremetech-resolve.mjs):
    -- resolved once per job, so a rescore never presses the apply button again.
    -- A failed attempt keeps its error and is retried after a day.
    -- The weekly statistics run (scripts/jobs/weekly-stats.mjs): one row per
    -- week (its Sunday, Israel time). The previous row gives week-over-week
    -- deltas; /statistics reads the latest one in full.
    CREATE TABLE IF NOT EXISTS weekly_reports (
      week_start    TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      analysis_json TEXT,
      status        TEXT NOT NULL CHECK(status IN ('analyzed', 'fallback')),
      created_at    INTEGER NOT NULL,
      sent_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS hiremetech_targets (
      job_id      TEXT PRIMARY KEY,
      company     TEXT,
      target_url  TEXT,
      method      TEXT,
      error       TEXT,
      resolved_at INTEGER NOT NULL
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

    -- Which WhatsApp group / LinkedIn search brought each job. sources_json is
    -- cleared once a job is rejected or decided, so per-group and per-search
    -- yield (weekly-stats.mjs) needs this small, never-wiped record.
    CREATE TABLE IF NOT EXISTS job_source_labels (
      job_key       TEXT NOT NULL,
      label         TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (job_key, label)
    );
    CREATE INDEX IF NOT EXISTS job_source_labels_seen_idx ON job_source_labels(first_seen_at);

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

  // SQLite cannot widen a CHECK list in place: copy into a table that allows
  // every current decision (e.g. 'applied', 'not_interested').
  const jobDecisionsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_decisions'").get()?.sql || '';
  if (!DECISION_KEYS.every((key) => jobDecisionsSql.includes(`'${key}'`))) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE job_decisions RENAME TO job_decisions_legacy;
        ${jobDecisionsTableSql('job_decisions')}
        INSERT INTO job_decisions (${JOB_DECISION_COLUMNS}) SELECT ${JOB_DECISION_COLUMNS} FROM job_decisions_legacy;
        DROP TABLE job_decisions_legacy;
        CREATE INDEX IF NOT EXISTS job_decisions_decided_idx ON job_decisions(decided_at);
      `);
    })();
  }

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

  // Refusal rows carry their HTTP status, Retry-After and whether the one
  // retry recovered (added 2026-10-24).
  if (!db.prepare('PRAGMA table_info(linkedin_requests)').all().some((column) => column.name === 'detail')) {
    db.exec('ALTER TABLE linkedin_requests ADD COLUMN detail TEXT');
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
  // A short title/company hint from the WhatsApp message of a shared LinkedIn
  // link, for the filter that runs before the link is read (2026-10-24).
  if (!jobColumns.some((column) => column.name === 'link_hint')) {
    db.exec('ALTER TABLE jobs ADD COLUMN link_hint TEXT');
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
    -- What the scheduled health check (scripts/jobs/health-check.mjs) found.
    -- A finding stays one row while it persists; resolved_at closes it, and a
    -- later recurrence reopens it with a new first_seen_at.
    CREATE TABLE IF NOT EXISTS health_findings (
      finding_key   TEXT PRIMARY KEY,
      area          TEXT NOT NULL,
      severity      TEXT NOT NULL CHECK(severity IN ('error', 'warn', 'info')),
      title         TEXT NOT NULL,
      detail        TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      resolved_at   INTEGER
    );

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
  // Daily automatic resolution of candidate companies (company-auto-resolve.mjs):
  // its outcome, the reason when a company cannot be scanned, and when to retry.
  const companyColumns = db.prepare('PRAGMA table_info(companies)').all().map((column) => column.name);
  for (const [name, type] of Object.entries({
    auto_status: 'TEXT', auto_reason: 'TEXT', auto_detail: 'TEXT', auto_checked_at: 'INTEGER', auto_next_at: 'INTEGER',
  })) {
    if (!companyColumns.includes(name)) db.exec(`ALTER TABLE companies ADD COLUMN ${name} ${type}`);
  }
  // Estimated LinkedIn posting time from the card's "N hours ago" label;
  // listed_at alone is only a date.
  if (!db.prepare('PRAGMA table_info(linkedin_postings)').all().some((column) => column.name === 'posted_at')) {
    db.exec('ALTER TABLE linkedin_postings ADD COLUMN posted_at INTEGER');
  }

  // error_reason: the tail of a failed call's message (sanitized, as scoring
  // failures are), so a failure can be explained after the fact.
  for (const column of ['source_mix', 'error_reason']) {
    if (db.prepare('PRAGMA table_info(codex_calls)').all().some((existing) => existing.name === column)) continue;
    try { db.exec(`ALTER TABLE codex_calls ADD COLUMN ${column} TEXT`); }
    catch (error) { if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || ''))) throw error; }
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
}
