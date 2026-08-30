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

const logger = pino({ level: process.env.JOBOPS_WA_LOG_LEVEL || 'silent' });
const MAX_RESTART_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 750;
const HISTORY_INITIAL_WAIT_MS = 30_000;
const HISTORY_MAX_WAIT_MS = 120_000;
const HISTORY_QUIET_MS = 3_000;

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
} = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const authDiagnostics = {
    processedHistoryMessages: Array.isArray(state.creds.processedHistoryMessages)
      ? state.creds.processedHistoryMessages.length
      : 0,
    accountSyncCounter: Number(state.creds.accountSyncCounter || 0),
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    let generation = 0;

    async function start() {
      const socketGeneration = ++generation;
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        ...createWhatsAppSocketOptions({ auth: state, logger }),
        version,
      });

      if (persistCredentials) sock.ev.on('creds.update', saveCreds);
      sock.historyStore = new Map();
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

      const collect = (messages = [], eventType) => {
        const boundedMessages = messages.slice(0, 5_000);
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
        try {
          onMessages?.(boundedMessages);
        } catch (error) {
          sock.ingressError = error;
        }
      };

      const collectChats = (chats) => {
        for (const chat of chats || []) {
          if (!chat?.id) continue;
          sock.chatStore.set(chat.id, { ...(sock.chatStore.get(chat.id) || {}), ...chat });
        }
      };

      sock.ev.on('messaging-history.set', ({ messages, chats }) => {
        collect(messages, 'history');
        collectChats(chats);
      });
      sock.ev.on('messages.upsert', ({ messages }) => collect(messages, 'upsert'));
      sock.ev.on('chats.upsert', collectChats);
      sock.ev.on('chats.update', collectChats);

      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          console.log('\nסרוק את קוד ה-QR ב-WhatsApp → מכשירים מקושרים:\n');
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
          const openedAt = Date.now();
          const waitForHistory = () => {
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
              setTimeout(waitForHistory, 500);
              return;
            }
            sock.historyDiagnostics.waitOutcome = outcome;
            sock.historyDiagnostics.waitMs = now - openedAt;
            resolve(sock);
          };
          setTimeout(waitForHistory, 500);
          return;
        }

        if (connection !== 'close') return;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          reject(new Error('WhatsApp session is logged out; remove the configured auth directory and pair again.'));
        } else if (shouldRetryWhatsAppConnection(statusCode) && attempts < MAX_RESTART_ATTEMPTS) {
          attempts += 1;
          setTimeout(() => start().catch(reject), RECONNECT_DELAY_MS * attempts);
        } else {
          reject(new Error(`WhatsApp connection closed before ready (status ${statusCode}).`));
        }
      });
    }

    start().catch(reject);
  });
}

export async function disconnectWhatsApp(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    await sock.end(undefined);
  } catch {
    // Best-effort teardown; scan results are already persisted locally.
  }
}
