const HISTORY_BATCH = 50;
const HISTORY_WAIT_MS = 12_000;
const MAX_BATCHES = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchGroupMessagesSince(sock, group, sinceMs) {
  const collected = () => sock.historyStore.get(group.jid) ?? new Map();
  const oldest = () => [...collected().values()].sort(
    (left, right) => Number(left.messageTimestamp) - Number(right.messageTimestamp),
  )[0];

  let cursor = oldest();
  let batches = 0;
  while (cursor && Number(cursor.messageTimestamp) * 1000 > sinceMs && batches < MAX_BATCHES) {
    batches += 1;
    const before = collected().size;
    try {
      await sock.fetchMessageHistory(HISTORY_BATCH, cursor.key, cursor.messageTimestamp);
      await sleep(HISTORY_WAIT_MS);
    } catch (error) {
      console.warn(`⚠️ ${group.name}: WhatsApp history fetch failed (${error.message}).`);
      break;
    }
    if (collected().size === before) break;
    cursor = oldest();
  }

  const allMessages = [...collected().values()];
  const timestamps = allMessages
    .map((message) => Number(message.messageTimestamp) * 1_000)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  const oldestAt = timestamps.length ? Math.min(...timestamps) : null;
  const newestAt = timestamps.length ? Math.max(...timestamps) : null;
  const messages = allMessages
    .filter((message) => Number(message.messageTimestamp) * 1000 >= sinceMs)
    .sort((left, right) => Number(left.messageTimestamp) - Number(right.messageTimestamp));

  if (!sock.groupHistoryDiagnostics) sock.groupHistoryDiagnostics = new Map();
  sock.groupHistoryDiagnostics.set(group.jid, {
    status: oldestAt == null ? 'unknown' : oldestAt <= sinceMs ? 'complete' : 'partial',
    requestedFrom: sinceMs,
    oldestAt,
    newestAt,
    delivered: messages.length,
    collected: allMessages.length,
    batches,
  });

  return messages;
}
