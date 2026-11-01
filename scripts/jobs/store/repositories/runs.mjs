import { observedRun } from '../../diagnostics.mjs';
import { parseSources, parseJson, requiredAuditField, serializeAuditDetails } from '../shared.mjs';

export function createRunsRepository({ db, store }) {
  return {
    async listFinishedRunsForSource(source, limit) {
      return await db.prepare(`
        SELECT * FROM runs
        WHERE finished_at IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(runs.sources) WHERE value = ?)
        ORDER BY started_at DESC LIMIT ?
      `).all(source, limit);
    },

    async listFailedRunEvents(runId, limit = 30) {
      return await db.prepare(`SELECT source, scope, scope_key AS scopeKey, stage, status, details_json AS details
        FROM run_events WHERE run_id = ? AND status IN ('failed', 'error', 'partial') ORDER BY id LIMIT ?`).all(runId, limit);
    },

    async startRun({ fromTs, toTs, sources, startedAt = Date.now(), ownerPid = null, actionId = null }) {
      return (await db.prepare(`
        INSERT INTO runs (started_at, from_ts, to_ts, sources, status, owner_pid, heartbeat_at, stage, action_id)
        VALUES (?, ?, ?, ?, 'running', ?, ?, 'setup', ?)
      `).run(startedAt, fromTs, toTs, JSON.stringify(sources), ownerPid, startedAt, actionId)).lastInsertRowid;
    },

    async touchRun(runId, { stage = null, details = null } = {}) {
      await db.prepare("UPDATE runs SET heartbeat_at = ?, stage = COALESCE(?, stage), details_json = COALESCE(?, details_json) WHERE id = ? AND status = 'running'")
        .run(Date.now(), stage, details ? JSON.stringify(details) : null, runId);
    },

    // windowStatus is the run's status judged without LinkedIn; it anchors
    // the next ATS/WhatsApp window even when only LinkedIn fell short.
    async finishRun(runId, { status, error = null, details = null, failure = null, windowStatus = null, finishedAt = Date.now() }) {
      await db.prepare('UPDATE runs SET finished_at = ?, status = ?, error = ?, details_json = COALESCE(?, details_json), diagnostic_json = ?, window_status = ? WHERE id = ?')
        .run(finishedAt, status, error ?? null, details ? JSON.stringify(details) : null, serializeAuditDetails(failure), windowStatus, runId);
    },

    async recordRunEvent(runId, {
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
      return (await db.prepare(`
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
      )).lastInsertRowid;
    },

    async listRunEvents(runId, { limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2_000));
      return (await db.prepare(`
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
      `).all(runId, boundedLimit)).map(({ detailsJson, ...event }) => ({
        ...event,
        details: parseJson(detailsJson, null),
      }));
    },

    async getLastRun() {
      const row = await db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get();
      return row ? await store.getRun(row.id) : null;
    },

    // Lightweight window query for rolling aggregates (per-group WhatsApp
    // stats, ATS-vs-WhatsApp cost comparisons): each finished run already
    // carries its own per-source, per-group breakdown in details_json
    // (see summarizeProcessingResults/summarizeSourceResults in jobs.mjs),
    // so summing across a time window needs no new event stream — just the
    // finished runs whose window it falls in. Unfinished runs are excluded:
    // their details_json may be a stale mid-run snapshot or absent.
    async listRuns({ sinceMs, limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2_000));
      const rows = await db.prepare(`
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

    async getLastRunSummary() {
      const row = await db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
      if (!row) return null;
      const { details_json: detailsJson, diagnostic_json: diagnosticJson, ...run } = row;
      return observedRun({
        ...run,
        diagnostic: parseJson(diagnosticJson),
        details: parseJson(detailsJson),
      });
    },

    async getRun(id) {
      const row = await db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
      if (!row) return null;
      const { details_json: detailsJson, diagnostic_json: diagnosticJson, ...run } = row;
      // The detail view uses the newest events, including the terminal failure,
      // even when a scan produced more than the display limit.
      const events = await db.prepare('SELECT id FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 500').all(id);
      const firstId = events.at(-1)?.id || 0;
      const rows = await db.prepare('SELECT * FROM run_events WHERE run_id = ? AND id >= ? ORDER BY id').all(id, firstId);
      return observedRun({ ...run, diagnostic: parseJson(diagnosticJson), details: parseJson(detailsJson),
        eventCount: (await db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?').get(id)).count,
        events: rows.map((event) => ({ id: event.id, runId: id, source: event.source, scope: event.scope,
          scopeKey: event.scope_key, stage: event.stage, status: event.status, count: event.item_count,
          createdAt: event.created_at, details: parseJson(event.details_json) })),
      });
    },

    async getLastSuccessfulRun(requiredSources = []) {
      const rows = await db.prepare(`
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
  };
}
