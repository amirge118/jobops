const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LINKEDIN_REQUEST_SENT = "kind NOT LIKE 'refused:%'";

// Raw facts behind /pulse. Shaping and judging them stays in jobs/pulse.mjs.
export function createPulseRepository({ db }) {
  return {
    async pulseCollectorFacts(now) {
      const run = await db.prepare('SELECT * FROM collector_runs ORDER BY id DESC LIMIT 1').get();
      if (!run) return null;
      const events = db.prepare('SELECT COUNT(*) AS n FROM collector_events WHERE collector_run_id = ? AND stage = ? AND created_at >= ?');
      return {
        run,
        reconnectsLast6h: (await events.get(run.id, 'reconnect', now - 6 * HOUR)).n,
        connectFailuresLast6h: (await events.get(run.id, 'connect', now - 6 * HOUR)).n,
        decryptFailuresLast6h: (await events.get(run.id, 'decrypt-failure', now - 6 * HOUR)).n,
        lastFailure: await db.prepare(`SELECT stage, details_json, created_at FROM collector_events
          WHERE collector_run_id = ? AND stage IN ('connect', 'connection-closed') ORDER BY id DESC LIMIT 1`).get(run.id),
      };
    },

    async pulseWhatsAppFacts(now) {
      const since = db.prepare('SELECT COUNT(*) AS n FROM processed_messages WHERE wa_timestamp >= ?');
      return {
        last1h: (await since.get(now - HOUR)).n,
        last6h: (await since.get(now - 6 * HOUR)).n,
        last24h: (await since.get(now - DAY)).n,
        lastMessageAt: (await db.prepare('SELECT MAX(wa_timestamp) AS at FROM processed_messages').get()).at,
        pending: await db.prepare(`SELECT COUNT(*) AS n, MIN(wa_timestamp) AS oldest FROM processed_messages WHERE status = 'pending' AND message_text IS NOT NULL`).get(),
      };
    },

    // The collector sends only alerts younger than 24h with < 5 attempts
    // (listPendingNotifications); older unsent ones expired and never will be.
    async pulseAlertFacts(now) {
      return {
        deliverable: await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM notification_outbox
          WHERE sent_at IS NULL AND attempts < 5 AND created_at >= ?`).get(now - DAY),
        expired7d: (await db.prepare(`SELECT COUNT(*) AS n FROM notification_outbox
          WHERE sent_at IS NULL AND (attempts >= 5 OR created_at < ?) AND created_at >= ?`).get(now - DAY, now - 7 * DAY)).n,
      };
    },

    async pulseLinkedInFacts(now) {
      const sentByKind = db.prepare(`SELECT kind, COUNT(*) AS n FROM linkedin_requests WHERE at >= ? AND ${LINKEDIN_REQUEST_SENT} GROUP BY kind`);
      return {
        state: await db.prepare('SELECT * FROM linkedin_state WHERE id = 1').get() || {},
        queue: await db.prepare(`SELECT last_error_code AS code, COUNT(*) AS n FROM jobs
          WHERE archived_at IS NULL AND last_error_code LIKE 'linkedin%' GROUP BY 1`).all(),
        sentLast1h: await sentByKind.all(now - HOUR),
        sentLast24h: await sentByKind.all(now - DAY),
        lastSearchAt: (await db.prepare("SELECT MAX(at) AS at FROM linkedin_requests WHERE kind = 'search'").get()).at,
        busiestHourLast24h: await db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', at / 1000, 'unixepoch') AS hour, COUNT(*) AS n
          FROM linkedin_requests WHERE at >= ? AND ${LINKEDIN_REQUEST_SENT} GROUP BY hour ORDER BY n DESC LIMIT 1`).get(now - DAY) ?? null,
        // Each refusal with the requests sent in the hour and the 10 minutes before it.
        refusals: await db.prepare(`SELECT r.at, substr(r.kind, 9) AS reason, r.detail,
            (SELECT COUNT(*) FROM linkedin_requests q WHERE q.at > r.at - 3600000 AND q.at <= r.at AND q.${LINKEDIN_REQUEST_SENT}) AS lastHour,
            (SELECT COUNT(*) FROM linkedin_requests q WHERE q.at > r.at - 600000 AND q.at <= r.at AND q.${LINKEDIN_REQUEST_SENT}) AS last10min
          FROM linkedin_requests r WHERE r.kind LIKE 'refused:%' AND r.at >= ? ORDER BY r.at`).all(now - DAY),
        refusals24h: await db.prepare(`SELECT last_error_code AS code, COUNT(*) AS n FROM jobs WHERE last_attempted_at >= ?
          AND last_error_code IN ('linkedin_rate_limited', 'linkedin_blocked') GROUP BY 1`).all(now - DAY),
        // Evaluated LinkedIn postings include ones known from the page cache or an
        // external twin; the request log counts what was actually fetched from LinkedIn.
        postingsEvaluated24h: (await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE canonical_url LIKE '%linkedin.com/jobs/view/%'
          AND evaluated_at >= ?`).get(now - DAY)).n,
        requestLogSince: (await db.prepare('SELECT MIN(at) AS at FROM linkedin_requests').get()).at,
      };
    },

    async pulseCodexFacts(now) {
      return {
        calls: await db.prepare('SELECT ok, error_code AS code, error_reason AS reason, created_at AS at FROM codex_calls WHERE created_at >= ? ORDER BY created_at DESC').all(now - DAY),
        blocked: await db.prepare('SELECT blocked_until AS until, blocked_reason AS reason FROM llm_state WHERE id = 1').get(),
      };
    },

    async pulseRunFacts(now) {
      return {
        stuck: await db.prepare(`SELECT id, sources, stage, heartbeat_at AS heartbeat FROM runs WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < ?`).all(now - 10 * MINUTE),
        running: await db.prepare(`SELECT id, sources, stage FROM runs WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) >= ?`).all(now - 10 * MINUTE),
      };
    },

    async pulseJobFacts(now) {
      return {
        evaluated24h: await db.prepare(`SELECT sources_json, canonical_url, first_suitable_at AS suitableAt,
          (SELECT source_kind FROM job_source_sightings s WHERE s.job_key = jobs.job_key ORDER BY s.first_seen_at DESC LIMIT 1) AS sightingKind
          FROM jobs WHERE evaluated_at >= ?`).all(now - DAY),
        // Same notion as the decisions page: first found suitable in the window.
        newSuitable24h: (await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE first_suitable_at >= ?').get(now - DAY)).n,
        evaluated6h: (await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE evaluated_at >= ?').get(now - 6 * HOUR)).n,
        failing: await db.prepare(`SELECT last_error_code AS code, COUNT(*) AS n FROM jobs WHERE archived_at IS NULL AND last_error_code IS NOT NULL
          AND last_error_code NOT LIKE 'linkedin%' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`).all(),
      };
    },

    async listOpenHealthFindings() {
      return await db.prepare('SELECT finding_key AS key, severity, title, first_seen_at AS since FROM health_findings WHERE resolved_at IS NULL').all();
    },
  };
}
