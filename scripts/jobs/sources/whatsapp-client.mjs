import {
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

export async function connectWhatsApp(authPath, {
  historyWarmupMs = 10_000,
  persistCredentials = true,
} = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  return new Promise((resolve, reject) => {
    let attempts = 0;

    async function start() {
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: true,
      });

      if (persistCredentials) sock.ev.on('creds.update', saveCreds);
      sock.historyStore = new Map();
      sock.chatStore = new Map();

      const collect = (messages) => {
        for (const message of messages) {
          const jid = message.key?.remoteJid;
          const id = message.key?.id;
          if (!jid || !id) continue;
          if (!sock.historyStore.has(jid)) sock.historyStore.set(jid, new Map());
          sock.historyStore.get(jid).set(id, message);
        }
      };

      const collectChats = (chats) => {
        for (const chat of chats || []) {
          if (!chat?.id) continue;
          sock.chatStore.set(chat.id, { ...(sock.chatStore.get(chat.id) || {}), ...chat });
        }
      };

      sock.ev.on('messaging-history.set', ({ messages, chats }) => {
        collect(messages);
        collectChats(chats);
      });
      sock.ev.on('messages.upsert', ({ messages }) => collect(messages));
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
        } else if (statusCode === DisconnectReason.restartRequired && attempts < MAX_RESTART_ATTEMPTS) {
          attempts += 1;
          start().catch(reject);
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
