import { processState } from '../../diagnostics.mjs';
import { parseJson, requiredAuditField, serializeAuditDetails } from '../shared.mjs';

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

export function createWhatsappHistoryRepository({ db, store }) {
  return {
    async getWhatsAppHistoryRequest(id) {
      const row = await db.prepare('SELECT * FROM whatsapp_history_requests WHERE id = ?').get(Number(id));
      if (!row) return null;
      const groups = (await db.prepare('SELECT * FROM whatsapp_history_groups WHERE request_id = ? ORDER BY rowid')
        .all(Number(id))).map(mapWhatsAppHistoryGroup);
      return mapWhatsAppHistoryRequest(row, groups);
    },

    async getLatestWhatsAppHistoryRequest() {
      const id = (await db.prepare('SELECT id FROM whatsapp_history_requests ORDER BY id DESC LIMIT 1').get())?.id;
      return id == null ? null : await store.getWhatsAppHistoryRequest(id);
    },

    async requestWhatsAppHistory({ fromTs, toTs, groupsTotal, groups = [], createdAt = Date.now() }) {
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
      const create = await db.transaction(async () => {
        const active = await db.prepare("SELECT id FROM whatsapp_history_requests WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT 1").get();
        if (active) return { created: false, id: active.id };
        const id = (await db.prepare(`
          INSERT INTO whatsapp_history_requests (from_ts, to_ts, status, created_at, groups_total)
          VALUES (?, ?, 'pending', ?, ?)
        `).run(from, to, Number(createdAt), total)).lastInsertRowid;
        const insertGroup = db.prepare(`
          INSERT INTO whatsapp_history_groups (
            request_id, group_name, status, requested_from, updated_at
          ) VALUES (?, ?, 'pending', ?, ?)
        `);
        for (const group of normalizedGroups) await insertGroup.run(id, group.name, group.requestedFrom, Number(createdAt));
        return { created: true, id };
      })();
      return { created: create.created, request: await store.getWhatsAppHistoryRequest(create.id) };
    },

    async claimNextWhatsAppHistoryRequest({ ownerPid = process.pid, startedAt = Date.now() } = {}) {
      const claim = await db.transaction(async () => {
        const row = await db.prepare("SELECT id FROM whatsapp_history_requests WHERE status = 'pending' ORDER BY created_at LIMIT 1").get();
        if (!row) return null;
        const changed = (await db.prepare(`
          UPDATE whatsapp_history_requests
          SET status = 'running', owner_pid = ?, started_at = ?, finished_at = NULL, diagnostic_json = NULL
          WHERE id = ? AND status = 'pending'
        `).run(Number(ownerPid), Number(startedAt), row.id)).changes;
        return changed === 1 ? row.id : null;
      })();
      return claim == null ? null : await store.getWhatsAppHistoryRequest(claim);
    },

    async requeueInterruptedWhatsAppHistoryRequests() {
      return await db.transaction(async () => {
        const running = await db.prepare("SELECT id, owner_pid FROM whatsapp_history_requests WHERE status = 'running'").all();
        let recovered = 0;
        for (const row of running) {
          if (processState(row.owner_pid) !== 'dead') continue;
          recovered += (await db.prepare(`
            UPDATE whatsapp_history_requests
            SET status = 'pending', owner_pid = NULL, started_at = NULL, current_group = NULL,
                groups_completed = 0, messages_received = 0, messages_queued = 0,
                duplicates = 0, ignored = 0, rejected = 0, diagnostic_json = NULL
            WHERE id = ? AND status = 'running'
          `).run(row.id)).changes;
          await db.prepare(`
            UPDATE whatsapp_history_groups
            SET status = 'pending', delivered = 0, queued = 0, duplicates = 0,
                ignored = 0, rejected = 0, oldest_at = NULL, newest_at = NULL,
                batches = 0, reason = NULL, updated_at = ?
            WHERE request_id = ?
          `).run(Date.now(), row.id);
        }
        return recovered;
      })();
    },

    async updateWhatsAppHistoryRequest(id, fields = {}) {
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
      return (await db.prepare(`UPDATE whatsapp_history_requests SET ${assignments.join(', ')} WHERE id = ? AND status = 'running'`)
        .run(...values)).changes === 1;
    },

    async recordWhatsAppHistoryGroup(requestId, {
      name, status, delivered = 0, queued = 0, duplicates = 0, ignored = 0, rejected = 0,
      oldestAt = null, newestAt = null, batches = 0, reason = null, requestedFrom = null, updatedAt = Date.now(),
    }) {
      const counts = [delivered, queued, duplicates, ignored, rejected, batches].map(Number);
      if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('WhatsApp history group counts must be non-negative integers');
      const normalizedRequestedFrom = requestedFrom == null ? null : Number(requestedFrom);
      if (normalizedRequestedFrom != null && (!Number.isSafeInteger(normalizedRequestedFrom) || normalizedRequestedFrom < 0)) {
        throw new Error('WhatsApp history group requestedFrom must be a non-negative timestamp');
      }
      await db.prepare(`
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

    async finishWhatsAppHistoryRequest(id, { status, failure = null, finishedAt = Date.now() } = {}) {
      if (!['complete', 'partial', 'failed'].includes(status)) throw new Error('WhatsApp history terminal status is invalid');
      return (await db.prepare(`
        UPDATE whatsapp_history_requests
        SET status = ?, finished_at = ?, current_group = NULL, diagnostic_json = ?
        WHERE id = ? AND status = 'running'
      `).run(status, Number(finishedAt), serializeAuditDetails(failure), Number(id))).changes === 1;
    },
  };
}
