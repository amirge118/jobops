#!/usr/bin/env node

import { connectWhatsApp, disconnectWhatsApp } from './sources/whatsapp-client.mjs';
import { markConfiguredGroupsRead, verifyConfiguredGroups } from './sources/whatsapp.mjs';
import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';

async function main() {
  let store;
  let sock;
  try {
    const config = loadJobsConfig();
    const whatsapp = config.sources.whatsapp;
    if (!whatsapp?.enabled) throw new Error('WhatsApp is disabled in config/jobs.yml');

    store = createJobStore(config.jobsDbPath);
    const collector = store.getCollectorStatus();
    if (collector && ['starting', 'connecting', 'connected', 'reconnecting', 'pairing_required', 'unconfirmed'].includes(collector.status)) {
      console.log(`Collector #${collector.id} מנהל אישורי קריאה לאחר שמירת ההודעות; לא נפתח חיבור WhatsApp נוסף.`);
      return;
    }
    sock = await connectWhatsApp(whatsapp.authAbsPath, { historyWarmupMs: 20_000 });
    const verification = await verifyConfiguredGroups(config, sock);
    const missing = verification.filter((group) => !group.found);
    if (missing.length) throw new Error(`Missing groups: ${missing.map((group) => group.name).join(', ')}`);

    const results = await markConfiguredGroupsRead(config, sock, { store });
    for (const result of results) {
      if (result.marked) {
        const detail = ['message-receipts', 'stored-message-receipts'].includes(result.method)
          ? `${result.messages} מזהי הודעות ${result.method === 'stored-message-receipts' ? 'שנשמרו בריצות קודמות' : 'שהתקבלו בחיבור הנוכחי'}`
          : `מצב הצ'אט, ${result.unreadBefore} לא נקראו לפני הפעולה`;
        console.log(`✓ ${result.name}: נשלח סימון קריאה (${detail}); הפעולה אינה סריקת משרות ואינה אימות מונה הלא-נקראו בטלפון.`);
      } else {
        console.log(`✗ ${result.name}: לא סומן (${result.error})`);
      }
    }
    const failed = results.filter((result) => !result.marked);
    if (failed.length) throw new Error(`${failed.length} מתוך ${results.length} קבוצות לא סומנו כנקראו`);
  } finally {
    if (sock) await disconnectWhatsApp(sock);
    store?.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`סימון WhatsApp כנקרא נכשל: ${error.message}`);
    process.exit(1);
  });
