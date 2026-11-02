const DAY = 24 * 60 * 60 * 1000;

// What `prune` may touch. Everything else — job identities, decisions,
// sightings, WhatsApp message dedup, HireMeTech targets, the tracker — is
// never deleted: dedup and every statistic depend on it.
export const RETENTION_CATEGORIES = Object.freeze({
  page_content: {
    label: 'תוכן עמודי משרות שנדחו או הועברו לארכיון (נקרא שוב אם צריך)',
    olderThanDays: 30,
    count: `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(p.content)), 0) AS bytes FROM job_pages p
      JOIN jobs j ON j.canonical_url = p.canonical_url
      WHERE p.content <> '' AND p.fetched_at < @cutoff AND (j.archived_at IS NOT NULL OR (j.evaluated_at IS NOT NULL AND j.suitable = 0))`,
    apply: `UPDATE job_pages SET content = '' WHERE canonical_url IN (
      SELECT p.canonical_url FROM job_pages p JOIN jobs j ON j.canonical_url = p.canonical_url
      WHERE p.content <> '' AND p.fetched_at < @cutoff AND (j.archived_at IS NOT NULL OR (j.evaluated_at IS NOT NULL AND j.suitable = 0)))`,
  },
  linkedin_postings: {
    label: 'רשומות פרסום LinkedIn של משרות בארכיון',
    olderThanDays: 60,
    count: `SELECT COUNT(*) AS rows, 0 AS bytes FROM linkedin_postings l JOIN jobs j ON j.job_key = l.job_key
      WHERE j.archived_at IS NOT NULL AND j.archived_at < @cutoff`,
    apply: `DELETE FROM linkedin_postings WHERE job_key IN (
      SELECT job_key FROM jobs WHERE archived_at IS NOT NULL AND archived_at < @cutoff)`,
  },
  collector_events: {
    label: 'אירועי חיבור של ה-Collector',
    olderThanDays: 30,
    count: 'SELECT COUNT(*) AS rows, 0 AS bytes FROM collector_events WHERE created_at < @cutoff',
    apply: 'DELETE FROM collector_events WHERE created_at < @cutoff',
  },
});

// An archived job loses its company; the decision keeps it.
const UNKNOWN_COMPANY = "(company IS NULL OR LOWER(TRIM(company)) IN ('', 'unknown', 'unknown company', 'חברה לא ידועה', 'לא ידוע', 'לא צוין'))";

export function createWeeklyStatsRepository({ db, userId }) {
  return {
    async retentionProposal({ now = Date.now() } = {}) {
      return await Promise.all(Object.entries(RETENTION_CATEGORIES).map(async ([category, rule]) => {
        const { rows, bytes } = await db.prepare(rule.count).get({ cutoff: now - rule.olderThanDays * DAY });
        return { category, label: rule.label, olderThanDays: rule.olderThanDays, rows, mb: Math.round((bytes / 1_048_576) * 10) / 10 };
      }));
    },

    async applyRetention(categories, { now = Date.now() } = {}) {
      const unknown = categories.filter((category) => !RETENTION_CATEGORIES[category]);
      if (unknown.length) throw new Error(`Unknown retention categories: ${unknown.join(', ')}`);
      const run = db.transaction(async () => await Promise.all(categories.map(async (category) => {
        const rule = RETENTION_CATEGORIES[category];
        return { category, changed: (await db.prepare(rule.apply).run({ cutoff: now - rule.olderThanDays * DAY })).changes };
      })));
      return await run();
    },

    // Raw facts behind the weekly report. Rejected and decided jobs keep only
    // their identity, so "scored" comes from the per-run scan counts and
    // "suitable" from first_suitable_at.
    async weeklySnapshotFacts(now) {
      const weekAgo = now - 7 * DAY;
      return {
        decisions: await db.prepare('SELECT job_key, decision FROM job_decisions WHERE user_id = ?').all(userId),
        labels: await db.prepare(`
          SELECT l.job_key, l.label, l.first_seen_at, j.first_suitable_at IS NOT NULL AS suitable
          FROM job_source_labels l LEFT JOIN jobs j ON j.job_key = l.job_key WHERE l.first_seen_at >= ?
        `).all(now - 30 * DAY),
        labelsSince: (await db.prepare('SELECT MIN(first_seen_at) AS at FROM job_source_labels').get())?.at ?? null,
        messages: await db.prepare(`
          SELECT group_jid AS jid, SUM(wa_timestamp >= ?) AS week, COUNT(*) AS month
          FROM processed_messages WHERE wa_timestamp >= ? GROUP BY group_jid
        `).all(weekAgo, now - 30 * DAY),
        searchProgress: await db.prepare(`
          SELECT s.label, p.last_status AS lastStatus, p.last_reason AS lastReason, p.last_success_at AS lastSuccessAt, p.gaps_json AS gaps
          FROM linkedin_searches s
          LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.last_attempt_at = (
            SELECT MAX(last_attempt_at) FROM linkedin_search_progress WHERE search_id = s.id)
          WHERE s.enabled = 1
        `).all(),
        seen: (await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at >= ?').get(weekAgo)).n,
        scanned: await db.prepare('SELECT SUM(scored) AS scored, SUM(suitable) AS suitable FROM source_scan_stats WHERE scanned_at >= ?').get(weekAgo),
        week: await db.prepare(`
          SELECT COUNT(*) AS suitable,
            SUM(NOT EXISTS (SELECT 1 FROM job_source_sightings s WHERE s.job_key = jobs.job_key)) AS noSource
          FROM jobs WHERE first_suitable_at >= ?
        `).get(weekAgo),
        named: await db.prepare(`
          SELECT COUNT(*) AS total, SUM(${UNKNOWN_COMPANY}) AS unknown FROM (
            SELECT company FROM job_decisions WHERE user_id = @userId AND decided_at >= @since
            UNION ALL
            SELECT company FROM jobs WHERE first_suitable_at >= @since AND archived_at IS NULL AND suitable = 1
          )
        `).get({ since: weekAgo, userId }),
        failureCodes: await db.prepare(`
          SELECT last_error_code AS code, COUNT(*) AS count FROM jobs
          WHERE last_error_code IS NOT NULL AND archived_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 6
        `).all(),
        hiremetech: await db.prepare(`
          SELECT COUNT(*) AS total, SUM(target_url IS NOT NULL) AS resolved, SUM(target_url IS NULL) AS failed,
            SUM(resolved_at >= ?) AS thisWeek FROM hiremetech_targets
        `).get(weekAgo),
        codexRows: await db.prepare(`
          SELECT purpose, COUNT(*) AS calls, SUM(ok) AS ok,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens
          FROM codex_calls WHERE created_at >= ? GROUP BY purpose
        `).all(weekAgo),
        findings: await db.prepare('SELECT finding_key AS key, severity, title, first_seen_at AS firstSeenAt, resolved_at AS resolvedAt FROM health_findings').all(),
      };
    },
  };
}
