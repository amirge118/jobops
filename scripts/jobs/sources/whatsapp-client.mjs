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

export async function connectWhatsApp(authPath, {
  historyWarmupMs = 10_000,
  persistCredentials = true,
  onMessages = null,
} = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  return new Promise((resolve, reject) => {
    let attempts = 0;

    async function start() {
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        ...createWhatsAppSocketOptions({ auth: state, logger }),
        version,
      });

      if (persistCredentials) sock.ev.on('creds.update', saveCreds);
      sock.historyStore = new Map();
      sock.chatStore = new Map();
      sock.historyDiagnostics = { historyEvents: 0, upsertEvents: 0, messages: 0 };
      sock.ingressError = null;

      const collect = (messages = [], eventType) => {
        const boundedMessages = messages.slice(0, 5_000);
        sock.historyDiagnostics.messages += boundedMessages.length;
        if (eventType === 'history') sock.historyDiagnostics.historyEvents += 1;
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
          setTimeout(() => resolve(sock), historyWarmupMs);
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
