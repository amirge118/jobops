const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only genuine metadata may become a history cursor or a receipt key. Never
// fabricate a message ID/fromMe value or store a body as part of an anchor.
export function normalizeWhatsAppAnchor(message, groupJid) {
  const key = message?.key;
  const timestamp = Number(message?.messageTimestamp);
  if (!key || typeof groupJid !== 'string' || groupJid.length > 128 ||
      key.remoteJid !== groupJid || typeof key.id !== 'string' || !key.id || key.id.length > 256 ||
      typeof key.fromMe !== 'boolean' || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
      timestamp * 1000 > Date.now() + 300_000 ||
      (key.participant != null && (typeof key.participant !== 'string' || key.participant.length > 128))) return null;
  return { key: { id: key.id, remoteJid: groupJid, fromMe: key.fromMe,
    ...(key.participant ? { participant: key.participant } : {}) }, messageTimestamp: timestamp };
}

async function withDeadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('History request timeout'), { code: 'HISTORY_TIMEOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function fetchGroupMessagesSince(sock, group, sinceMs, {
  store, untilMs = null, anchorWaitMs = 0, waitMs = 12_000,
  requestTimeoutMs = 12_000, maxBatches = 20, totalTimeoutMs = 180_000,
  now = Date.now, sleep: pause = sleep,
} = {}) {
  const started = now();
  const deadline = started + Math.max(1, Math.min(totalTimeoutMs, 300_000));
  const validMessages = () => [...(sock.historyStore.get(group.jid)?.values() || [])]
    .filter((message) => normalizeWhatsAppAnchor(message, group.jid));
  const currentHead = () => {
    const messages = validMessages().map((message) => ({ message, source: 'received' }));
    const chatMessages = (sock.chatStore?.get(group.jid)?.messages || []).slice(0, 50)
      .map((item) => item.message).filter((message) => normalizeWhatsAppAnchor(message, group.jid));
    return [...messages, ...chatMessages.map((message) => ({ message, source: 'current-chat' }))]
      .sort((a, b) => Number(b.message.messageTimestamp) - Number(a.message.messageTimestamp))[0] || null;
  };
  const saved = normalizeWhatsAppAnchor(store?.getWhatsAppAnchor?.(group.jid), group.jid);
  let head = currentHead();
  // A saved cursor within/after the window can recover older messages, but is
  // NOT proof that newer messages since that cursor have been collected.
  if (saved && saved.messageTimestamp * 1000 > sinceMs && (!head || saved.messageTimestamp > Number(head.message.messageTimestamp))) {
    head = { message: saved, source: 'stored' };
  }
  const hasRecentHead = () => head && (untilMs == null || Number(head.message.messageTimestamp) * 1000 >= untilMs);
  const waitUntil = Math.min(deadline, started + Math.max(0, Math.min(anchorWaitMs, 60_000)));
  while (!hasRecentHead() && now() < waitUntil) {
    await pause(Math.min(500, waitUntil - now()));
    const fresh = currentHead();
    if (fresh && (!head || Number(fresh.message.messageTimestamp) >= Number(head.message.messageTimestamp))) head = fresh;
  }
  const actualAnchorWaitMs = Math.min(now() - started, Math.max(0, Math.min(anchorWaitMs, 60_000)));
  if (head) store?.saveWhatsAppAnchor?.(group.jid, head.message);
  const tailConfirmed = hasRecentHead();
  let cursor = head?.message;
  // Always walk backwards from the newest real anchor. The minimum timestamp
  // in a mixed live/history buffer alone cannot prove there are no gaps.
  let batches = 0;
  let reason = !head ? (saved ? 'anchor_too_old' : 'missing_anchor') : null;
  const attempted = new Set();
  while (cursor && Number(cursor.messageTimestamp) * 1000 > sinceMs && batches < Math.min(maxBatches, 20) && now() < deadline) {
    if (attempted.has(cursor.key.id)) { reason = 'history_no_progress'; break; }
    attempted.add(cursor.key.id);
    batches += 1;
    const before = new Set(validMessages().map((message) => message.key.id));
    const beforeRevision = sock.historyBatches?.get(group.jid)?.revision || 0;
    let expectedSessionId = null;
    const deliveredBatch = () => {
      if (sock.historyBatches) {
        const batch = sock.historyBatches.get(group.jid);
        const matchingSession = !expectedSessionId || !batch?.sessionId || batch.sessionId === expectedSessionId;
        return batch?.revision > beforeRevision && matchingSession
          ? batch.messages.filter((message) => normalizeWhatsAppAnchor(message, group.jid))
          : [];
      }
      // Compatibility with injected adapters without delivery tracking.
      return validMessages().filter((message) => !before.has(message.key.id));
    };
    try {
      expectedSessionId = await withDeadline(
        () => sock.fetchMessageHistory(50, cursor.key, cursor.messageTimestamp),
        Math.max(1, Math.min(requestTimeoutMs, deadline - now())),
      );
      if (typeof expectedSessionId !== 'string') expectedSessionId = null;
    } catch (error) {
      reason = error.code === 'HISTORY_TIMEOUT' ? 'history_request_timeout' : 'history_request_failed';
      break;
    }
    const batchDeadline = Math.min(deadline, now() + Math.max(0, Math.min(waitMs, 12_000)));
    while (!deliveredBatch().length && now() < batchDeadline) {
      await pause(Math.min(250, batchDeadline - now()));
    }
    const oldest = deliveredBatch().sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))[0];
    if (!oldest) {
      reason = 'history_no_response'; break;
    }
    if (Number(oldest.messageTimestamp) >= Number(cursor.messageTimestamp)) { reason = 'history_no_progress'; break; }
    cursor = oldest;
  }
  const allMessages = validMessages();
  // A current-chat message has actually arrived, unlike a saved metadata cursor.
  if (head?.source === 'current-chat' && !allMessages.some((message) => message.key.id === head.message.key.id)) allMessages.push(head.message);
  const timestamps = allMessages.map((message) => Number(message.messageTimestamp) * 1000);
  const oldestAt = timestamps.length ? Math.min(...timestamps) : null;
  const newestAt = timestamps.length ? Math.max(...timestamps) : null;
  const messages = allMessages.filter((message) => Number(message.messageTimestamp) * 1000 >= sinceMs &&
      (untilMs == null || Number(message.messageTimestamp) * 1000 <= untilMs))
    .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
  const complete = batches > 0 && Number(cursor?.messageTimestamp) * 1000 <= sinceMs && tailConfirmed && !reason;
  if (!complete && !reason) reason = now() >= deadline ? 'history_deadline' : batches >= Math.min(maxBatches, 20) ? 'history_batch_limit' :
    !tailConfirmed ? 'newer_messages_unverified' : 'history_boundary_missing';
  if (!sock.groupHistoryDiagnostics) sock.groupHistoryDiagnostics = new Map();
  sock.groupHistoryDiagnostics.set(group.jid, {
    status: complete ? 'complete' : allMessages.length ? 'partial' : 'unknown',
    requestedFrom: sinceMs, requestedUntil: untilMs, oldestAt, newestAt,
    delivered: messages.length, collected: allMessages.length, batches,
    anchorSource: head?.source || null, tailConfirmed: Boolean(tailConfirmed), reason,
    anchorWaitMs: actualAnchorWaitMs,
  });
  return messages;
}
