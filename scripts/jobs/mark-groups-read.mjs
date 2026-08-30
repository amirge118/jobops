#!/usr/bin/env node

import { connectWhatsApp, disconnectWhatsApp } from './sources/whatsapp-client.mjs';
import { markConfiguredGroupsRead, verifyConfiguredGroups } from './sources/whatsapp.mjs';
import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';

function suppressKnownLibsignalNoise() {
  const methods = ['error', 'warn', 'info'];
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
      const first = String(args[0] ?? '');
      if (noisyPrefixes.some((prefix) => first.startsWith(prefix))) return;
      originals.get(method)(...args);
    };
  }
  return () => {
    for (const method of methods) console[method] = originals.get(method);
  };
}

async function main() {
  const restoreConsole = suppressKnownLibsignalNoise();
  let store;
  let sock;
  try {
    const config = loadJobsConfig();
    const whatsapp = config.sources.whatsapp;
    if (!whatsapp?.enabled) throw new Error('WhatsApp is disabled in config/jobs.yml');

    store = createJobStore(config.jobsDbPath);
    sock = await connectWhatsApp(whatsapp.authAbsPath, { historyWarmupMs: 20_000 });
    const verification = await verifyConfiguredGroups(config, sock);
    const missing = verification.filter((group) => !group.found);
    if (missing.length) throw new Error(`Missing groups: ${missing.map((group) => group.name).join(', ')}`);

    const results = await markConfiguredGroupsRead(config, sock, { store });
    for (const result of results) {
      if (result.marked) {
        const detail = ['message-receipts', 'stored-message-receipts'].includes(result.method)
          ? `${result.messages} הודעות שנאספו`
          : `מצב הצ'אט, ${result.unreadBefore} לא נקראו לפני הפעולה`;
        console.log(`✓ ${result.name}: סומן כנקרא (${detail})`);
      } else {
        console.log(`✗ ${result.name}: לא סומן (${result.error})`);
      }
    }
    const failed = results.filter((result) => !result.marked);
    if (failed.length) throw new Error(`${failed.length} מתוך ${results.length} קבוצות לא סומנו כנקראו`);
  } finally {
    if (sock) await disconnectWhatsApp(sock);
    store?.close();
    restoreConsole();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`סימון WhatsApp כנקרא נכשל: ${error.message}`);
    process.exit(1);
  });
