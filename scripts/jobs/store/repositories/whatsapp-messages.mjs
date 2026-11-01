import { normalizeWhatsAppAnchor } from '../../sources/whatsapp-history.mjs';
import { parseJson } from '../shared.mjs';

export function createWhatsappMessagesRepository({ db, store }) {
  return {
    async shouldProcessMessage(messageId) {
      const row = await db.prepare('SELECT status FROM processed_messages WHERE message_id = ?').get(messageId);
      return !row || row.status !== 'done';
    },

    async queueWhatsAppMessage({ messageId, groupJid, timestamp, text }) {
      const result = await db.prepare(`
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

    async markWhatsAppMessagesRead(keys, { readAt = Date.now() } = {}) {
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
      return await db.transaction(async (items) => {
        let marked = 0;
        for (const key of items) {
          if (typeof key?.id !== 'string' || !key.id || key.id.length > 256 ||
              typeof key?.remoteJid !== 'string' || !key.remoteJid || key.remoteJid.length > 128) continue;
          marked += (await update.run(timestamp, timestamp, key.id, key.remoteJid)).changes;
        }
        return marked;
      })(keys);
    },

    async saveWhatsAppAnchor(groupJid, message) {
      const anchor = normalizeWhatsAppAnchor(message, groupJid);
      if (!anchor) return false;
      return (await db.prepare(`INSERT INTO whatsapp_anchors (group_jid, message_key_json, timestamp) VALUES (?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET message_key_json = excluded.message_key_json, timestamp = excluded.timestamp
        WHERE excluded.timestamp >= whatsapp_anchors.timestamp`)
        .run(groupJid, JSON.stringify(anchor.key), anchor.messageTimestamp)).changes > 0;
    },

    async getWhatsAppAnchor(groupJid) {
      const row = await db.prepare('SELECT message_key_json, timestamp FROM whatsapp_anchors WHERE group_jid = ?').get(groupJid);
      return row ? normalizeWhatsAppAnchor({ key: parseJson(row.message_key_json), messageTimestamp: row.timestamp }, groupJid) : null;
    },

    async listPendingWhatsAppMessages(groupJid, { sinceMs = 0, untilMs = Date.now(), limit = 2_000, order = 'asc' } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 2_000, 5_000));
      if (!['asc', 'desc'].includes(order)) throw new Error('WhatsApp message order must be asc or desc');
      return await db.prepare(`
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

    async getWhatsAppBacklogStats({ sinceMs = 0, untilMs = Date.now() } = {}) {
      const rows = await db.prepare(`
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

    async getWhatsAppGroupCollectionStats(groupJid) {
      const row = await db.prepare(`
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

    async discardOldWhatsAppMessages({ beforeTs, discardedAt = Date.now() } = {}) {
      const cutoff = Number(beforeTs);
      const updatedAt = Number(discardedAt);
      if (!Number.isFinite(cutoff) || cutoff < 0) throw new Error('beforeTs must be a non-negative timestamp');
      if (!Number.isFinite(updatedAt) || updatedAt < 0) throw new Error('discardedAt must be a non-negative timestamp');
      return (await db.prepare(`
        UPDATE processed_messages
        SET status = 'done', message_text = NULL, last_error = NULL, updated_at = ?
        WHERE status IN ('pending', 'failed')
          AND message_text IS NOT NULL
          AND wa_timestamp < ?
      `).run(updatedAt, cutoff)).changes;
    },

    async listWhatsAppMessageKeys(groupJid, { limit = 2_000 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 2_000, 5_000));
      return (await db.prepare(`
        SELECT message_id AS id, group_jid AS remoteJid
        FROM processed_messages
        WHERE group_jid = ? AND message_id IS NOT NULL
        ORDER BY wa_timestamp DESC
        LIMIT ?
      `).all(groupJid, boundedLimit)).map((key) => ({ ...key, fromMe: false }));
    },

    async getMessageState(messageId) {
      const row = await db.prepare(`
        SELECT status, message_text IS NOT NULL AS has_text
        FROM processed_messages
        WHERE message_id = ?
      `).get(messageId);
      return row ? { status: row.status, hasText: Boolean(row.has_text) } : null;
    },

    async markMessageDone({ messageId, groupJid, timestamp = null }) {
      await db.prepare(`
        INSERT INTO processed_messages (message_id, group_jid, wa_timestamp, message_text, status, updated_at)
        VALUES (?, ?, ?, NULL, 'done', ?)
        ON CONFLICT(message_id) DO UPDATE SET
          status = 'done', wa_timestamp = excluded.wa_timestamp,
          message_text = NULL, last_error = NULL, updated_at = excluded.updated_at
      `).run(messageId, groupJid, timestamp, Date.now());
    },

    async markMessageFailed({ messageId, groupJid, error }) {
      await db.prepare(`
        INSERT INTO processed_messages (
          message_id, group_jid, status, retry_count, last_error, updated_at
        ) VALUES (?, ?, 'failed', 1, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          status = 'failed', retry_count = processed_messages.retry_count + 1,
          last_error = excluded.last_error, updated_at = excluded.updated_at
      `).run(messageId, groupJid, String(error ?? '').slice(0, 500), Date.now());
    },

    async importWhatsAppState({ messages = [], checkpoints = [] }) {
      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO processed_messages (
          message_id, group_jid, wa_timestamp, status, retry_count, updated_at
        ) VALUES (@messageId, @groupJid, @timestamp, 'done', 0, @updatedAt)
      `);
      const importMessages = db.transaction(async (rows) => {
        let imported = 0;
        for (const row of rows) {
          if (!row.message_id || !row.group_jid) continue;
          imported += (await insertMessage.run({
            messageId: row.message_id,
            groupJid: row.group_jid,
            timestamp: Number(row.wa_timestamp) || null,
            updatedAt: Number(row.processed_at) || Date.now(),
          })).changes;
        }
        return imported;
      });
      const messagesImported = await importMessages(messages);

      for (const checkpoint of checkpoints) {
        if (!checkpoint.group_jid) continue;
        await store.setCheckpoint(
          `whatsapp:${checkpoint.group_jid}`,
          Number(checkpoint.last_wa_timestamp) || 0,
        );
      }
      return { messagesImported, checkpointsSeen: checkpoints.length };
    },
  };
}
