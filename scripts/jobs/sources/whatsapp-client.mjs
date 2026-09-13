import {
  Browsers,
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { normalizeWhatsAppAnchor } from './whatsapp-history.mjs';

const logger = pino({ level: process.env.JOBOPS_WA_LOG_LEVEL || 'silent' });
const MAX_RESTART_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 750;
const HISTORY_INITIAL_WAIT_MS = 30_000;
const HISTORY_MAX_WAIT_MS = 120_000;
const HISTORY_QUIET_MS = 3_000;

// libsignal occasionally writes complete SessionEntry objects directly to the
// console. Those objects contain private ratchet keys, so suppress the known
// diagnostic prefixes at the connection boundary instead of relying on callers
// or dashboard redaction.
export function suppressKnownLibsignalNoise() {
  const methods = ['error', 'warn', 'info', 'log'];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  const noisyPrefixes = [
    'Failed to decrypt message with any known session',
    'Session error:',
    'Closing open session in favor of incoming prekey bundle',
    'Closing session:',
    'Session already closed',
    'Session already open',
  ];
  for (const method of methods) {
    console[method] = (...args) => {
      if (noisyPrefixes.some((prefix) => String(args[0] ?? '').startsWith(prefix))) return;
      originals.get(method)(...args);
    };
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const method of methods) console[method] = originals.get(method);
  };
}

export function shouldRetryWhatsAppConnection(statusCode) {
  return statusCode === DisconnectReason.connectionClosed ||
    statusCode === DisconnectReason.connectionLost ||
    statusCode === DisconnectReason.timedOut ||
    statusCode === DisconnectReason.unavailableService ||
    statusCode === DisconnectReason.restartRequired;
}

export function createWhatsAppSocketOptions({ auth, logger: socketLogger }) {
  return {
    auth,
    logger: socketLogger,
    // WhatsApp currently terminates Baileys desktop identities with status
    // 428 before the socket can open. A web-browser identity remains supported
    // and lets the long-lived Collector receive new messages reliably.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: true,
  };
}

export function decideHistoryWait({
  elapsedMs,
  historyEvents,
  historyNotifications,
  lastActivityAgoMs,
  initialWaitMs = HISTORY_INITIAL_WAIT_MS,
  maxWaitMs = HISTORY_MAX_WAIT_MS,
  quietMs = HISTORY_QUIET_MS,
}) {
  if (elapsedMs >= maxWaitMs) return 'timeout';
  const hasActivity = historyEvents > 0 || historyNotifications > 0;
  if (!hasActivity && elapsedMs >= initialWaitMs) return 'empty';
  if (hasActivity && historyEvents >= historyNotifications && lastActivityAgoMs >= quietMs) {
    return 'settled';
  }
  return 'wait';
}

export async function connectWhatsApp(authPath, {
  historyWarmupMs = HISTORY_INITIAL_WAIT_MS,
  historyMaxWaitMs = HISTORY_MAX_WAIT_MS,
  historyQuietMs = HISTORY_QUIET_MS,
  persistCredentials = true,
  onMessages = null,
  onIngressError = null,
  onConnectionUpdate = null,
  onQr = null,
  configuredGroupJids = null,
  waitForHistory = true,
} = {}) {
  const restoreConsole = suppressKnownLibsignalNoise();
  let state;
  let saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authPath));
  } catch (error) {
    restoreConsole();
    throw error;
  }
  const authDiagnostics = {
    processedHistoryMessages: Array.isArray(state.creds.processedHistoryMessages)
      ? state.creds.processedHistoryMessages.length
      : 0,
    accountSyncCounter: Number(state.creds.accountSyncCounter || 0),
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    let generation = 0;
    let settled = false;

    const finishResolve = (sock) => {
      if (settled) return;
      settled = true;
      sock.restoreWhatsAppConsole = restoreConsole;
      resolve(sock);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      restoreConsole();
      reject(error);
    };

    async function start() {
      const socketGeneration = ++generation;
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        ...createWhatsAppSocketOptions({ auth: state, logger }),
        version,
      });

      if (persistCredentials) sock.ev.on('creds.update', saveCreds);
      sock.historyStore = new Map();
      sock.historyBatches = new Map();
      sock.chatStore = new Map();
      sock.groupHistoryDiagnostics = new Map();
      sock.historyDiagnostics = {
        historyEvents: 0,
        historyNotifications: 0,
        upsertEvents: 0,
        messages: 0,
        waitOutcome: null,
        waitMs: 0,
      };
      sock.authDiagnostics = authDiagnostics;
      sock.ingressError = null;
      let lastHistoryActivityAt = Date.now();
      const initialProcessedHistoryMessages = authDiagnostics.processedHistoryMessages;

      sock.ev.on('creds.update', (update) => {
        if (!Array.isArray(update.processedHistoryMessages)) return;
        sock.historyDiagnostics.historyNotifications = Math.max(
          0,
          update.processedHistoryMessages.length - initialProcessedHistoryMessages,
        );
        lastHistoryActivityAt = Date.now();
      });

      const collect = (messages = [], eventType, { sessionId = null } = {}) => {
        const scopedMessages = configuredGroupJids ? messages.filter((message) => configuredGroupJids.has(message.key?.remoteJid)) : messages;
        const boundedMessages = scopedMessages.slice(0, 5_000);
        sock.historyDiagnostics.messages += boundedMessages.length;
        if (eventType === 'history') {
          sock.historyDiagnostics.historyEvents += 1;
          lastHistoryActivityAt = Date.now();
        }
        if (eventType === 'upsert') sock.historyDiagnostics.upsertEvents += 1;
        for (const message of boundedMessages) {
          const jid = message.key?.remoteJid;
          const id = message.key?.id;
          if (!jid || !id) continue;
          if (!sock.historyStore.has(jid)) sock.historyStore.set(jid, new Map());
          sock.historyStore.get(jid).set(id, message);
        }
        // A history response can repeat IDs already in memory. Track its
        // delivery separately from live upserts so neither is mistaken for a
        // successful pagination response. Keep only the latest batch per group.
        if (eventType === 'history') {
          const batches = new Map();
          for (const message of boundedMessages) {
            const jid = message.key?.remoteJid;
            const anchor = normalizeWhatsAppAnchor(message, jid);
            if (!anchor) continue;
            if (!batches.has(jid)) batches.set(jid, []);
            batches.get(jid).push(anchor);
          }
          for (const [jid, messages] of batches) sock.historyBatches.set(jid, {
            revision: (sock.historyBatches.get(jid)?.revision || 0) + 1,
            sessionId: typeof sessionId === 'string' ? sessionId : null,
            messages,
          });
        }
        try {
          onMessages?.(boundedMessages, sock);
        } catch (error) {
          sock.ingressError = error;
          try { onIngressError?.(error, sock); }
          catch { /* Preserve the original persistence failure. */ }
        }
      };

      const collectChats = (chats) => {
        for (const chat of chats || []) {
          if (!chat?.id) continue;
          if (configuredGroupJids && !configuredGroupJids.has(chat.id)) continue;
          sock.chatStore.set(chat.id, { ...(sock.chatStore.get(chat.id) || {}), ...chat });
        }
      };

      sock.ev.on('messaging-history.set', ({ messages, chats, peerDataRequestSessionId }) => {
        collect(messages, 'history', { sessionId: peerDataRequestSessionId });
        collectChats(chats);
      });
      sock.ev.on('messages.upsert', ({ messages }) => collect(messages, 'upsert'));
      sock.ev.on('chats.upsert', collectChats);
      sock.ev.on('chats.update', collectChats);

      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        try { onConnectionUpdate?.({ connection, lastDisconnect, qr: Boolean(qr) }, sock); }
        catch (error) { sock.ingressError = error; }
        if (qr) {
          onQr?.(qr);
          if (process.env.JOBOPS_HIDE_QR !== '1') {
            console.log('\nסרוק את קוד ה-QR ב-WhatsApp → מכשירים מקושרים:\n');
            qrcodeTerminal.generate(qr, { small: true });
          }
        }

        if (connection === 'open') {
          if (!waitForHistory) {
            finishResolve(sock);
            return;
          }
          const openedAt = Date.now();
          const pollHistory = () => {
            if (socketGeneration !== generation) return;
            const now = Date.now();
            const outcome = decideHistoryWait({
              elapsedMs: now - openedAt,
              historyEvents: sock.historyDiagnostics.historyEvents,
              historyNotifications: sock.historyDiagnostics.historyNotifications,
              lastActivityAgoMs: now - lastHistoryActivityAt,
              initialWaitMs: historyWarmupMs,
              maxWaitMs: historyMaxWaitMs,
              quietMs: historyQuietMs,
            });
            if (outcome === 'wait') {
              setTimeout(pollHistory, 500);
              return;
            }
            sock.historyDiagnostics.waitOutcome = outcome;
            sock.historyDiagnostics.waitMs = now - openedAt;
            finishResolve(sock);
          };
          setTimeout(pollHistory, 500);
          return;
        }

        if (connection !== 'close') return;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        // Once a long-lived caller owns the open socket, it is responsible for
        // reconnect policy. Starting an untracked socket here would create two
        // consumers of the same Signal session.
        if (settled) return;
        if (statusCode === DisconnectReason.loggedOut) {
          finishReject(new Error('WhatsApp session is logged out; pairing required.'));
        } else if (shouldRetryWhatsAppConnection(statusCode) && attempts < MAX_RESTART_ATTEMPTS) {
          attempts += 1;
          setTimeout(() => start().catch(finishReject), RECONNECT_DELAY_MS * attempts);
        } else {
          finishReject(new Error(`WhatsApp connection closed before ready (status ${statusCode}).`));
        }
      });
    }

    start().catch(finishReject);
  });
}

export async function disconnectWhatsApp(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    await sock.end(undefined);
  } catch {
    // Best-effort teardown; scan results are already persisted locally.
  } finally {
    sock.restoreWhatsAppConsole?.();
  }
}
