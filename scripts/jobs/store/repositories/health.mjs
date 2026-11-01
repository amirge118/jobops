export function createHealthRepository({ db, store }) {
  return {
    // Raw facts for the health check; the rules live in health-check.mjs.
    async listHealthFacts({ now = Date.now(), sinceMs = 24 * 60 * 60 * 1000 } = {}) {
      const since = Number(now) - Number(sinceMs);
      const lastRunOf = async (source) => await db.prepare(`
        SELECT id, status, started_at AS startedAt, finished_at AS finishedAt FROM runs
        WHERE finished_at IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(runs.sources) WHERE value = ?)
        ORDER BY started_at DESC LIMIT 1
      `).get(source) ?? null;
      return {
        now: Number(now),
        companyFailures: await db.prepare(`
          SELECT scope_key AS company, COUNT(DISTINCT run_id) AS runs, MAX(created_at) AS lastAt,
            (SELECT json_extract(e2.details_json, '$.code') FROM run_events e2
              WHERE e2.scope = 'company' AND e2.scope_key = e.scope_key AND e2.status = 'failed'
              ORDER BY e2.created_at DESC LIMIT 1) AS code
          FROM run_events e
          WHERE source = 'ats' AND scope = 'company' AND status = 'failed' AND created_at >= ?
          GROUP BY scope_key
        `).all(since),
        lastRuns: Object.fromEntries(await Promise.all(['ats', 'linkedin', 'whatsapp-backlog'].map(async (source) => [source, await lastRunOf(source)]))),
        stuckRuns: await db.prepare(`
          SELECT id, sources, stage, heartbeat_at AS heartbeatAt, started_at AS startedAt FROM runs
          WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < ?
        `).all(Number(now) - 10 * 60 * 1000),
        codexCalls: await db.prepare(`
          SELECT ok, error_code AS errorCode, error_reason AS errorReason, purpose, created_at AS createdAt
          FROM codex_calls WHERE created_at >= ? ORDER BY created_at DESC
        `).all(since),
        llmBlockedUntil: (await db.prepare('SELECT blocked_until AS blockedUntil FROM llm_state WHERE id = 1').get())?.blockedUntil ?? null,
        linkedinBlockedUntil: (await db.prepare('SELECT blocked_until AS blockedUntil FROM linkedin_state WHERE id = 1').get())?.blockedUntil ?? null,
        hireMeTechLoggedOutAt: (await db.prepare('SELECT last_timestamp FROM checkpoints WHERE source_key = ?').get('hiremetech:logged_out'))?.last_timestamp ?? null,
        hireMeTechResolvedAt: (await db.prepare('SELECT last_timestamp FROM checkpoints WHERE source_key = ?').get('hiremetech:resolved'))?.last_timestamp ?? null,
        linkedinSearches: await db.prepare(`
          SELECT s.search_key AS key, p.last_status AS lastStatus, p.last_reason AS lastReason,
            p.last_success_at AS lastSuccessAt, p.last_attempt_at AS lastAttemptAt
          FROM linkedin_searches s
          LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.last_attempt_at = (
            SELECT MAX(last_attempt_at) FROM linkedin_search_progress WHERE search_id = s.id)
          WHERE s.enabled = 1
        `).all(),
        collector: await store.getCollectorStatusSummary(),
        oldestPendingMessageAt: (await db.prepare(`
          SELECT MIN(wa_timestamp) AS at FROM processed_messages WHERE status = 'pending' AND message_text IS NOT NULL
        `).get())?.at ?? null,
        lastGroupMessageAt: (await db.prepare('SELECT MAX(wa_timestamp) AS at FROM processed_messages').get())?.at ?? null,
        failedJobs: await db.prepare(`
          SELECT last_error_code AS code, COUNT(*) AS count, MIN(last_attempted_at) AS oldestAttemptAt FROM jobs
          WHERE archived_at IS NULL AND last_error_code IS NOT NULL GROUP BY last_error_code
        `).all(),
        resumeGapFailures: (await db.prepare(`
          SELECT COUNT(*) AS count FROM jobs WHERE archived_at IS NULL AND resume_gap_error_code IS NOT NULL
        `).get()).count,
      };
    },

    async listHealthFindings({ includeResolved = false } = {}) {
      return await db.prepare(`
        SELECT finding_key AS key, area, severity, title, detail, first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt, resolved_at AS resolvedAt
        FROM health_findings ${includeResolved ? '' : 'WHERE resolved_at IS NULL'}
        ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, first_seen_at
      `).all();
    },

    // Upserts the current findings and resolves the ones no longer found.
    // Returns the findings that are new (opened or reopened) in this check.
    async saveHealthFindings(findings, at = Date.now()) {
      const opened = [];
      await db.transaction(async () => {
        const active = new Map((await db.prepare('SELECT finding_key AS key FROM health_findings WHERE resolved_at IS NULL').all())
          .map((row) => [row.key, true]));
        for (const finding of findings) {
          if (!active.has(finding.key)) opened.push({ ...finding, firstSeenAt: at });
          await db.prepare(`
            INSERT INTO health_findings (finding_key, area, severity, title, detail, first_seen_at, last_seen_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(finding_key) DO UPDATE SET area = excluded.area, severity = excluded.severity, title = excluded.title,
              detail = excluded.detail, last_seen_at = excluded.last_seen_at,
              first_seen_at = CASE WHEN health_findings.resolved_at IS NULL THEN health_findings.first_seen_at ELSE excluded.first_seen_at END,
              resolved_at = NULL
          `).run(finding.key, finding.area, finding.severity, String(finding.title).slice(0, 200),
            finding.detail == null ? null : String(finding.detail).slice(0, 500), at, at);
          active.delete(finding.key);
        }
        for (const key of active.keys()) {
          await db.prepare('UPDATE health_findings SET resolved_at = ? WHERE finding_key = ?').run(at, key);
        }
        await db.prepare('DELETE FROM health_findings WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(at - 30 * 24 * 60 * 60 * 1000);
        await store.setCheckpoint('health_checked_at', at);
      })();
      return opened;
    },

    async getHealthCheckedAt() {
      return await store.getCheckpoint('health_checked_at');
    },
  };
}
