import { normalizeMessageContent } from '@whiskeysockets/baileys';

import { connectWhatsApp, disconnectWhatsApp } from './whatsapp-client.mjs';
import { fetchGroupMessagesSince, normalizeWhatsAppAnchor } from './whatsapp-history.mjs';
import { describeFailure } from '../diagnostics.mjs';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;
// Baileys commonly delivers history in batches of up to 5,000. Keep the
// persistence bound aligned with the transport bound so a valid batch is not
// silently truncated a second time.
const MAX_INGRESS_MESSAGES = 5_000;
const MAX_MESSAGE_ID_CHARS = 256;
const MAX_GROUP_JID_CHARS = 128;
const MAX_MESSAGE_TEXT_CHARS = 32_000;
const READ_RECEIPT_BATCH_SIZE = 100;

async function sendReceiptBatch(sock, keys, timeoutMs) {
  let timer;
  try {
    await Promise.race([sock.readMessages(keys), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Read receipt acknowledgement timed out')), Math.max(1, Math.min(timeoutMs, 30_000)));
    })]);
  } finally { clearTimeout(timer); }
}

function messageText(message) {
  const body = normalizeMessageContent(message.message);
  if (!body) return '';
  return body.conversation ||
    body.extendedTextMessage?.text ||
    body.imageMessage?.caption ||
    body.videoMessage?.caption ||
    body.documentMessage?.caption ||
    '';
}

export function queueIncomingMessages({ messages = [], configuredGroupJids, store, sinceMs = 0 }) {
  const result = { queued: 0, duplicates: 0, ignored: 0, rejected: 0 };
  const boundedMessages = messages.slice(0, MAX_INGRESS_MESSAGES);
  result.rejected += Math.max(0, messages.length - boundedMessages.length);

  for (const message of boundedMessages) {
    const messageId = message.key?.id;
    const groupJid = message.key?.remoteJid;
    if (!configuredGroupJids.has(groupJid)) {
      result.ignored += 1;
      continue;
    }

    store.saveWhatsAppAnchor?.(groupJid, message);
    const timestamp = Number(message.messageTimestamp) * 1_000;
    const text = messageText(message);
    if (
      typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_MESSAGE_ID_CHARS ||
      typeof groupJid !== 'string' || groupJid.length > MAX_GROUP_JID_CHARS ||
      !Number.isFinite(timestamp) || timestamp <= 0 ||
      typeof text !== 'string' || text.length > MAX_MESSAGE_TEXT_CHARS
    ) {
      result.rejected += 1;
      continue;
    }
    if (timestamp < sinceMs) {
      result.ignored += 1;
      continue;
    }

    const queued = store.queueWhatsAppMessage({ messageId, groupJid, timestamp, text });
    result[queued ? 'queued' : 'duplicates'] += 1;
  }

  return result;
}

function messageUrls(text) {
  const urls = (text.match(URL_PATTERN) || []).map((url) => url.replace(/[.,;)\]]+$/, ''));
  return [...new Set(urls)];
}

export function diagnoseUnavailableHistory(groups, diagnostics = {}, authDiagnostics = {}) {
  const noEvents = Number(diagnostics.historyEvents || 0) === 0 &&
    Number(diagnostics.upsertEvents || 0) === 0;
  const existingSessionAlreadySynced = Number(authDiagnostics.processedHistoryMessages || 0) > 0;
  const noAnchors = groups.length > 0 && groups.every(
    (group) => group.coverage?.status === 'unknown' && Number(group.coverage?.delivered || 0) === 0,
  );
  if (!noEvents || !existingSessionAlreadySynced || !noAnchors) return groups;

  const error = 'WhatsApp לא שלח היסטוריה לחיבור הקיים. יש לבדוק סנכרון; ייתכן שיידרש session חדש, אך אין לאפס אותו אוטומטית.';
  return groups.map((group) => ({
    ...group,
    coverage: { ...group.coverage, status: 'failed', reason: group.coverage.reason || 'stale-session-no-anchor' },
    error: group.error || error,
  }));
}

export async function verifyConfiguredGroups(config, sock) {
  const participating = await sock.groupFetchAllParticipating();
  return config.sources.whatsapp.groups.map((configured) => {
    const live = participating[configured.jid];
    return {
      name: configured.name,
      jid: configured.jid,
      found: Boolean(live),
      liveName: live?.subject ?? null,
      participants: live?.participants?.length ?? null,
    };
  });
}

export async function markConfiguredGroupsRead(config, sock, { store } = {}) {
  const groups = config.sources.whatsapp?.groups || [];
  const results = [];

  for (const group of groups) {
    const messages = [...(sock.historyStore?.get(group.jid)?.values() || [])]
      .filter((message) => message.key?.id && !message.key?.fromMe);
    try {
      if (messages.length > 0) {
        await sock.readMessages(messages.map((message) => message.key));
        results.push({ name: group.name, marked: true, method: 'message-receipts', messages: messages.length });
        continue;
      }

      const chat = sock.chatStore?.get(group.jid);
      const liveTimestamp = Number(chat?.lastMessageRecvTimestamp || 0);
      const checkpointMs = Number(store?.getCheckpoint(`whatsapp:${group.jid}`) || 0);
      const storedTimestamp = checkpointMs > 0 ? Math.floor(checkpointMs / 1_000) : 0;
      const lastMessageTimestamp = Math.max(liveTimestamp, storedTimestamp);
      if (lastMessageTimestamp > 0) {
        try {
          await sock.chatModify({
            markRead: true,
            lastMessages: { lastMessageTimestamp },
          }, group.jid);
          results.push({
            name: group.name,
            marked: true,
            method: 'chat-state',
            messages: 0,
            unreadBefore: Number(chat?.unreadCount || 0),
            anchor: liveTimestamp > 0 ? 'live-chat' : 'stored-checkpoint',
          });
          continue;
        } catch (chatStateError) {
          const storedKeys = store?.listWhatsAppMessageKeys(group.jid) || [];
          if (storedKeys.length === 0) throw chatStateError;
          for (let index = 0; index < storedKeys.length; index += READ_RECEIPT_BATCH_SIZE) {
            await sock.readMessages(storedKeys.slice(index, index + READ_RECEIPT_BATCH_SIZE));
          }
          results.push({
            name: group.name,
            marked: true,
            method: 'stored-message-receipts',
            messages: storedKeys.length,
            fallbackReason: String(chatStateError.message || chatStateError).slice(0, 200),
          });
          continue;
        }
      }

      results.push({
        name: group.name,
        marked: false,
        method: 'no-anchor',
        messages: 0,
        error: 'WhatsApp did not provide a message key or chat timestamp',
      });
    } catch (error) {
      results.push({ name: group.name, marked: false, method: 'error', messages: 0, error: error.message });
    }
  }
  return results;
}

function processPendingGroup({ group, store, sinceMs, untilMs, onDiagnostic, limit = 2_000, order = 'asc' }) {
  const pendingMessages = store.listPendingWhatsAppMessages(group.jid, { sinceMs, untilMs, limit, order });
  const candidates = [];
  let failedMessages = 0;
  let latestTimestamp = store.getCheckpoint(`whatsapp:${group.jid}`) ?? 0;

  for (const message of pendingMessages) {
    const { messageId, timestamp, text } = message;
    latestTimestamp = Math.max(latestTimestamp, timestamp);

    try {
      for (const url of messageUrls(text)) {
        const sighting = store.recordSighting({
          url,
          source: `WhatsApp: ${group.name}`,
          seenAt: timestamp,
        });
        candidates.push({
          ...sighting,
          url,
          source: `WhatsApp: ${group.name}`,
        });
      }
      store.markMessageDone({ messageId, groupJid: group.jid, timestamp });
    } catch (error) {
      const failure = describeFailure(error, 'collection_failed');
      store.markMessageFailed({ messageId, groupJid: group.jid, error: failure.reason });
      failedMessages += 1;
      if (failedMessages <= 20) onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'message-processing', status: 'failed', details: failure });
    }
  }

  if (latestTimestamp) store.setCheckpoint(`whatsapp:${group.jid}`, latestTimestamp);
  return { messages: pendingMessages.length, candidates, failedMessages };
}

export function scanWhatsAppBacklog({
  config,
  store,
  sinceMs = 0,
  untilMs = Date.now(),
  limitPerGroup = 100,
  onDiagnostic = () => {},
  onStage = () => {},
} = {}) {
  const groups = config.sources.whatsapp?.groups || [];
  const candidates = [];
  const results = [];
  onStage('local-backlog');

  for (const group of groups) {
    const processed = processPendingGroup({
      group, store, sinceMs, untilMs, onDiagnostic,
      limit: limitPerGroup, order: 'desc',
    });
    candidates.push(...processed.candidates);
    results.push({
      name: group.name,
      found: true,
      liveName: null,
      participants: null,
      messages: processed.messages,
      failedMessages: processed.failedMessages,
      candidates: processed.candidates.length,
      coverage: {
        status: 'complete', reason: null, source: 'local-backlog',
        requestedFrom: sinceMs, requestedUntil: untilMs,
        oldestAt: null, newestAt: null, delivered: processed.messages,
        collected: processed.messages, batches: processed.messages ? 1 : 0,
      },
      error: null,
      read: {
        name: group.name,
        marked: false,
        status: 'skipped',
        method: 'local-backlog',
        messages: 0,
        error: null,
      },
    });
  }

  return {
    source: 'whatsapp',
    candidates,
    ingress: { mode: 'local-backlog', queued: 0, duplicates: 0, ignored: 0, rejected: 0 },
    diagnostics: { localBacklog: true },
    groups: results,
  };
}

async function scanGroup({ sock, group, store, sinceMs, untilMs, onDiagnostic, historyOptions }) {
  const messages = await fetchGroupMessagesSince(sock, group, sinceMs, { store, untilMs, anchorWaitMs: 60_000, ...historyOptions });
  const coverage = sock.groupHistoryDiagnostics?.get(group.jid) || {
    status: 'unknown', requestedFrom: sinceMs, oldestAt: null, newestAt: null,
    delivered: messages.length, collected: messages.length, batches: 0,
  };
  queueIncomingMessages({
    messages,
    configuredGroupJids: new Set([group.jid]),
    store,
    sinceMs,
  });
  const processed = processPendingGroup({ group, store, sinceMs, untilMs, onDiagnostic });
  const successful = new Set();
  for (const message of messages) {
    if (store.getMessageState(message.key.id)?.status === 'done') successful.add(message.key.id);
  }
  // Scan receipts cover only delivered messages whose links were durably
  // extracted (or were already processed), not arbitrary stored IDs.
  const keys = messages.filter((message) => successful.has(message.key.id) || store.getMessageState(message.key.id)?.status === 'done')
    .map((message) => normalizeWhatsAppAnchor(message, group.jid)?.key).filter((key) => key && !key.fromMe);
  return { group: group.name, ...processed, coverage, receiptKeys: keys };
}

function latestGroupVerification(collector) {
  return [...(collector?.events || [])].reverse().find((event) => event.stage === 'group-verification')?.details?.groups || [];
}

export function scanCollectedWhatsApp({ config, store, sinceMs, untilMs = Date.now(), collector, onDiagnostic = () => {}, onStage = () => {} }) {
  const whatsapp = config.sources.whatsapp;
  const verification = new Map(latestGroupVerification(collector).map((group) => [group.name, group]));
  const connectedForWindow = collector?.status === 'connected' && Number(collector.connected_at || 0) <= sinceMs;
  const coverage = connectedForWindow
    ? { status: 'complete', reason: null, requestedFrom: sinceMs, newestAt: untilMs, delivered: 0, source: 'collector' }
    : { status: 'partial', reason: 'collector_gap', requestedFrom: sinceMs, newestAt: collector?.last_message_at || null, delivered: 0, source: 'collector' };
  const candidates = [];
  const groups = [];
  onStage('collector-inbox');

  for (const group of whatsapp.groups) {
    const result = processPendingGroup({ group, store, sinceMs, untilMs, onDiagnostic });
    candidates.push(...result.candidates);
    const known = verification.get(group.name);
    const groupCoverage = { ...coverage, delivered: result.messages };
    if (!connectedForWindow) onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'collector-coverage', status: 'warning', details: describeFailure(null, 'collector_gap') });
    groups.push({
      name: group.name,
      found: known?.found ?? null,
      liveName: known?.liveName ?? null,
      participants: known?.participants ?? null,
      messages: result.messages,
      failedMessages: result.failedMessages,
      candidates: result.candidates.length,
      coverage: groupCoverage,
      error: null,
      // The inbox scan cannot prove that the background collector sent a
      // receipt for these exact rows, so do not report a successful mark-read.
      read: whatsapp.markRead ? { name: group.name, marked: false, status: 'skipped', method: 'collector-unconfirmed', messages: 0, error: null } : null,
    });
  }

  return {
    source: 'whatsapp',
    candidates,
    ingress: { mode: 'collector', collectorRunId: collector.id },
    diagnostics: { collectorRunId: collector.id, connectedAt: collector.connected_at, lastMessageAt: collector.last_message_at },
    groups,
  };
}

export async function scanWhatsApp({ config, store, sinceMs, untilMs = Date.now(), onDiagnostic = () => {}, onStage = () => {}, connect = connectWhatsApp, disconnect = disconnectWhatsApp, historyOptions = {}, readTimeoutMs = 10_000 }) {
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) return { source: 'whatsapp', candidates: [], groups: [] };
  if (!whatsapp.authAbsPath) throw new Error('WhatsApp authPath is not configured');

  const collector = store.getCollectorStatus?.();
  if (collector && ['starting', 'connecting', 'connected', 'reconnecting', 'pairing_required', 'unconfirmed'].includes(collector.status)) {
    return scanCollectedWhatsApp({ config, store, sinceMs, untilMs, collector, onDiagnostic, onStage });
  }

  const configuredGroupJids = new Set(whatsapp.groups.map((group) => group.jid));
  const ingress = { queued: 0, duplicates: 0, ignored: 0, rejected: 0 };
  onStage('whatsapp-connect');
  const sock = await connect(whatsapp.authAbsPath, {
    configuredGroupJids,
    onMessages(messages) {
      const batch = queueIncomingMessages({ messages, configuredGroupJids, store, sinceMs });
      for (const key of Object.keys(ingress)) ingress[key] += batch[key];
    },
  });
  try {
    if (sock.ingressError) {
      throw new Error(`WhatsApp message persistence failed: ${sock.ingressError.message}`);
    }
    onStage('verify-groups');
    const verification = await verifyConfiguredGroups(config, sock);
    const missing = verification.filter((group) => !group.found);
    if (missing.length) {
      for (const group of missing) onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'verify-groups', status: 'failed', details: describeFailure(null, 'group_unavailable') });
      throw new Error(`Configured WhatsApp groups are unavailable: ${missing.map((group) => group.name).join(', ')}`);
    }

    onStage('history-coverage');
    const settled = await Promise.allSettled(
      whatsapp.groups.map(async (group) => {
        onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'history-coverage', status: 'started' });
        try {
          const result = await scanGroup({ sock, group, store, sinceMs, untilMs, onDiagnostic, historyOptions });
          onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'message-processing',
            status: result.failedMessages ? 'partial' : 'complete', count: result.messages,
            details: { failedMessages: result.failedMessages, candidates: result.candidates.length } });
          return result;
        } catch (error) {
          onDiagnostic({ scope: 'group', scopeKey: group.name, stage: 'history-coverage', status: 'failed', details: describeFailure(error, 'collection_failed') });
          throw error;
        }
      }),
    );
    const groups = [];
    const candidates = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        groups.push({
          ...verification[index],
          messages: result.value.messages,
          failedMessages: result.value.failedMessages,
          candidates: result.value.candidates.length,
          coverage: result.value.coverage,
          error: null,
        });
        candidates.push(...result.value.candidates);
      } else {
        groups.push({
          ...verification[index],
          messages: 0,
          candidates: 0,
          coverage: { status: 'failed', requestedFrom: sinceMs, oldestAt: null, newestAt: null, delivered: 0 },
          error: result.reason?.message ?? String(result.reason),
        });
      }
    }
    if (sock.ingressError) {
      throw new Error(`WhatsApp message persistence failed: ${sock.ingressError.message}`);
    }
    const diagnosedGroups = diagnoseUnavailableHistory(
      groups,
      sock.historyDiagnostics,
      sock.authDiagnostics,
    );
    if (whatsapp.markRead) onStage('mark-read');
    const readResults = [];
    if (whatsapp.markRead) {
      for (let index = 0; index < settled.length; index += 1) {
        const keys = settled[index].status === 'fulfilled' ? settled[index].value.receiptKeys : [];
        let sent = 0;
        try {
          for (let offset = 0; offset < keys.length; offset += READ_RECEIPT_BATCH_SIZE) {
            const batch = keys.slice(offset, offset + READ_RECEIPT_BATCH_SIZE);
            await sendReceiptBatch(sock, batch, readTimeoutMs); sent += batch.length;
          }
          readResults.push({ name: whatsapp.groups[index].name, marked: keys.length > 0, status: keys.length ? 'sent' : 'skipped',
            method: 'scan-message-receipts', messages: sent, error: null });
        } catch (error) {
          readResults.push({ name: whatsapp.groups[index].name, marked: false, status: 'failed', method: 'scan-message-receipts',
            messages: sent, error: describeFailure(error, 'read_failed').reason });
        }
      }
    }
    const readByName = new Map(readResults.map((result) => [result.name, result]));
    return {
      source: 'whatsapp',
      candidates,
      ingress,
      diagnostics: { ...sock.historyDiagnostics, ...sock.authDiagnostics },
      groups: diagnosedGroups.map((group) => ({ ...group, read: readByName.get(group.name) || null })),
    };
  } finally {
    await disconnect(sock);
  }
}
