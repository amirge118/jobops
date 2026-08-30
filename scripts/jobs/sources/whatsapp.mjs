import { normalizeMessageContent } from '@whiskeysockets/baileys';

import { connectWhatsApp, disconnectWhatsApp } from './whatsapp-client.mjs';
import { fetchGroupMessagesSince } from './whatsapp-history.mjs';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const MAX_INGRESS_MESSAGES = 2_000;
const MAX_MESSAGE_ID_CHARS = 256;
const MAX_GROUP_JID_CHARS = 128;
const MAX_MESSAGE_TEXT_CHARS = 32_000;
const READ_RECEIPT_BATCH_SIZE = 100;

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

  const error = 'WhatsApp לא שלח היסטוריה לחיבור הקיים, שכבר צרך סנכרון קודם. נדרש לקשר session חדש כדי לקבל נקודת התחלה להודעות הישנות.';
  return groups.map((group) => ({
    ...group,
    coverage: { ...group.coverage, status: 'failed', reason: 'stale-session-no-anchor' },
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

async function scanGroup({ sock, group, store, sinceMs, untilMs }) {
  const messages = await fetchGroupMessagesSince(sock, group, sinceMs);
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
  const pendingMessages = store.listPendingWhatsAppMessages(group.jid, { untilMs });
  const candidates = [];
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
      store.markMessageFailed({ messageId, groupJid: group.jid, error: error.message });
    }
  }

  if (latestTimestamp) store.setCheckpoint(`whatsapp:${group.jid}`, latestTimestamp);
  return { group: group.name, messages: pendingMessages.length, candidates, coverage };
}

export async function scanWhatsApp({ config, store, sinceMs, untilMs = Date.now() }) {
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) return { source: 'whatsapp', candidates: [], groups: [] };
  if (!whatsapp.authAbsPath) throw new Error('WhatsApp authPath is not configured');

  const configuredGroupJids = new Set(whatsapp.groups.map((group) => group.jid));
  const ingress = { queued: 0, duplicates: 0, ignored: 0, rejected: 0 };
  const sock = await connectWhatsApp(whatsapp.authAbsPath, {
    onMessages(messages) {
      const batch = queueIncomingMessages({ messages, configuredGroupJids, store, sinceMs });
      for (const key of Object.keys(ingress)) ingress[key] += batch[key];
    },
  });
  try {
    if (sock.ingressError) {
      throw new Error(`WhatsApp message persistence failed: ${sock.ingressError.message}`);
    }
    const verification = await verifyConfiguredGroups(config, sock);
    const missing = verification.filter((group) => !group.found);
    if (missing.length) {
      throw new Error(`Configured WhatsApp groups are unavailable: ${missing.map((group) => group.name).join(', ')}`);
    }

    const settled = await Promise.allSettled(
      whatsapp.groups.map((group) => scanGroup({ sock, group, store, sinceMs, untilMs })),
    );
    const groups = [];
    const candidates = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        groups.push({
          ...verification[index],
          messages: result.value.messages,
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
    const readResults = whatsapp.markRead ? await markConfiguredGroupsRead(config, sock, { store }) : [];
    const readByName = new Map(readResults.map((result) => [result.name, result]));
    return {
      source: 'whatsapp',
      candidates,
      ingress,
      diagnostics: { ...sock.historyDiagnostics, ...sock.authDiagnostics },
      groups: diagnosedGroups.map((group) => ({ ...group, read: readByName.get(group.name) || null })),
    };
  } finally {
    await disconnectWhatsApp(sock);
  }
}
