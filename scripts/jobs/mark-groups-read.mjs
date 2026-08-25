#!/usr/bin/env node

import { connectWhatsApp, disconnectWhatsApp } from './sources/whatsapp-client.mjs';
import { markConfiguredGroupsRead, verifyConfiguredGroups } from './sources/whatsapp.mjs';
import { loadJobsConfig } from './config.mjs';

async function main() {
  const config = loadJobsConfig();
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) throw new Error('WhatsApp is disabled in config/jobs.yml');

  const sock = await connectWhatsApp(whatsapp.authAbsPath, { historyWarmupMs: 20_000 });
  try {
    const verification = await verifyConfiguredGroups(config, sock);
    const missing = verification.filter((group) => !group.found);
    if (missing.length) throw new Error(`Missing groups: ${missing.map((group) => group.name).join(', ')}`);

    const results = await markConfiguredGroupsRead(config, sock);
    for (const result of results) {
      if (result.marked) {
        const detail = result.method === 'message-receipts'
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
    await disconnectWhatsApp(sock);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`סימון WhatsApp כנקרא נכשל: ${error.message}`);
    process.exit(1);
  });
