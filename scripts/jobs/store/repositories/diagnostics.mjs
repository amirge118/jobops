import { describeFailure, observedRun, processState } from '../../diagnostics.mjs';
import { parseSources, parseJson, requiredAuditField, serializeAuditDetails } from '../shared.mjs';

export function createDiagnosticsRepository({ db, store }) {
  return {
    async startAction(name, { ownerPid = process.pid } = {}) {
      return (await db.prepare("INSERT INTO action_runs (name, started_at, status, owner_pid) VALUES (?, ?, 'running', ?)")
        .run(requiredAuditField(name, 'action name'), Date.now(), ownerPid)).lastInsertRowid;
    },

    async updateAction(id, { childPid = null, status = 'running', failure = null, warnings = [], finishedAt = null } = {}) {
      await db.prepare('UPDATE action_runs SET child_pid = COALESCE(?, child_pid), status = ?, diagnostic_json = ?, warnings_json = ?, finished_at = ? WHERE id = ?')
        .run(childPid, status, serializeAuditDetails(failure), serializeAuditDetails(warnings.slice(0, 30)), finishedAt, id);
    },

    async getAction(id) {
      const row = await db.prepare('SELECT * FROM action_runs WHERE id = ?').get(id);
      if (!row) return null;
      const { diagnostic_json, warnings_json, ...action } = row;
      action.diagnostic = parseJson(diagnostic_json);
      action.warnings = parseJson(warnings_json, []);
      if (action.status === 'running' && processState(action.child_pid || action.owner_pid) === 'dead') {
        action.recordedStatus = 'running';
        action.status = 'interrupted';
        action.diagnostic = describeFailure(null, 'process_missing');
      }
      action.runIds = (await db.prepare('SELECT id FROM runs WHERE action_id = ? ORDER BY id DESC').all(id)).map((run) => run.id);
      return action;
    },

    async startCollectorRun({ ownerPid = process.pid, startedAt = Date.now(), groupsExpected = null } = {}) {
      return (await db.prepare(`
        INSERT INTO collector_runs (
          started_at, status, owner_pid, heartbeat_at, stage, groups_expected
        ) VALUES (?, 'starting', ?, ?, 'startup', ?)
      `).run(startedAt, ownerPid, startedAt, groupsExpected)).lastInsertRowid;
    },

    async updateCollectorRun(id, fields = {}) {
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
      return (await db.prepare(`UPDATE collector_runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values)).changes === 1;
    },

    async recordCollectorEvent(collectorRunId, {
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
      return (await db.prepare(`
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
      )).lastInsertRowid;
    },

    async finishCollectorRun(id, { status, failure = null, finishedAt = Date.now() } = {}) {
      await db.prepare(`
        UPDATE collector_runs SET
          finished_at = ?, status = ?, heartbeat_at = ?, diagnostic_json = ?
        WHERE id = ?
      `).run(finishedAt, requiredAuditField(status, 'collector status', 32), finishedAt, serializeAuditDetails(failure), id);
    },

    async getCollectorRunSummary(id) {
      const row = await db.prepare('SELECT * FROM collector_runs WHERE id = ?').get(id);
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

    async getCollectorRun(id) {
      const collector = await store.getCollectorRunSummary(id);
      if (!collector) return null;
      collector.eventCount = (await db.prepare('SELECT COUNT(*) AS count FROM collector_events WHERE collector_run_id = ?').get(id)).count;
      collector.events = (await db.prepare(`
        SELECT id, stage, status, item_count AS count, details_json AS detailsJson, created_at AS createdAt
        FROM collector_events WHERE collector_run_id = ? ORDER BY id DESC LIMIT 500
      `).all(id)).reverse().map(({ detailsJson, ...event }) => ({ ...event, details: parseJson(detailsJson) }));
      return collector;
    },

    async getCollectorStatus() {
      const row = await db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 1').get();
      return row ? await store.getCollectorRun(row.id) : null;
    },

    async getCollectorStatusSummary() {
      const row = await db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 1').get();
      return row ? await store.getCollectorRunSummary(row.id) : null;
    },

    async pruneDiagnostics({ keepRecent = 3 } = {}) {
      const limit = Number(keepRecent);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('keepRecent must be an integer between 1 and 20');
      }
      const prune = db.transaction(async () => {
        const before = {
          runs: (await db.prepare('SELECT COUNT(*) AS count FROM runs').get()).count,
          runEvents: (await db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).count,
          actions: (await db.prepare('SELECT COUNT(*) AS count FROM action_runs').get()).count,
          collectors: (await db.prepare('SELECT COUNT(*) AS count FROM collector_runs').get()).count,
          collectorEvents: (await db.prepare('SELECT COUNT(*) AS count FROM collector_events').get()).count,
        };
        const runs = await db.prepare('SELECT id, sources, COALESCE(window_status, status) AS status FROM runs ORDER BY id DESC').all();
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
          if (!recentRunIds.has(run.id)) await deleteEvents.run(run.id);
          if (!retainedRunIds.has(run.id)) await deleteRun.run(run.id);
          else if (!recentRunIds.has(run.id)) await compactRun.run(run.id);
        }

        const actionIds = await db.prepare('SELECT id FROM action_runs ORDER BY id DESC').all();
        for (const { id } of actionIds.slice(limit)) await db.prepare('DELETE FROM action_runs WHERE id = ?').run(id);
        const collectorIds = await db.prepare('SELECT id FROM collector_runs ORDER BY id DESC').all();
        for (const { id } of collectorIds.slice(limit)) await db.prepare('DELETE FROM collector_runs WHERE id = ?').run(id);

        const after = {
          runs: (await db.prepare('SELECT COUNT(*) AS count FROM runs').get()).count,
          runEvents: (await db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).count,
          actions: (await db.prepare('SELECT COUNT(*) AS count FROM action_runs').get()).count,
          collectors: (await db.prepare('SELECT COUNT(*) AS count FROM collector_runs').get()).count,
          collectorEvents: (await db.prepare('SELECT COUNT(*) AS count FROM collector_events').get()).count,
        };
        return {
          runsDeleted: before.runs - after.runs,
          eventsDeleted: (before.runEvents - after.runEvents) + (before.collectorEvents - after.collectorEvents),
          actionsDeleted: before.actions - after.actions,
          collectorsDeleted: before.collectors - after.collectors,
        };
      });
      return await prune();
    },

    async diagnosticHistory() {
      // This API is retained for CLI/support compatibility. The daily UI only shows
      // the newest result and automatic diagnosis.
      const runs = (await db.prepare('SELECT id, started_at, finished_at, status, sources, stage, owner_pid, heartbeat_at FROM runs ORDER BY id DESC LIMIT 3')
        .all()).map((run) => ({ ...observedRun(run), kind: 'runs' }));
      const actions = await Promise.all((await db.prepare('SELECT id FROM action_runs ORDER BY id DESC LIMIT 3').all())
        .map(async ({ id }) => ({ ...await store.getAction(id), kind: 'actions' })));
      const collectors = await Promise.all((await db.prepare('SELECT id FROM collector_runs ORDER BY id DESC LIMIT 3').all())
        .map(async ({ id }) => ({ ...await store.getCollectorRunSummary(id), kind: 'collectors' })));
      return [...runs, ...actions, ...collectors].sort((a, b) => b.started_at - a.started_at);
    },
  };
}
