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

  return [...collected().values()]
    .filter((message) => Number(message.messageTimestamp) * 1000 >= sinceMs)
    .sort((left, right) => Number(left.messageTimestamp) - Number(right.messageTimestamp));
}
