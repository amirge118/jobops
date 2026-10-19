#!/usr/bin/env node

// Scheduled, token-free health check (scripts/jobs/health-check.mjs): stores
// what needs attention for the scan page and alerts on WhatsApp about new
// problems (and on the Mac while the WhatsApp collector cannot send). Also
// runnable by hand:
//
//   npm run jobs:health-check               # check, store, alert on new findings
//   npm run jobs:health-check -- --no-notify

import { loadJobsConfig } from './jobs/config.mjs';
import { notifyMacOS, runHealthCheck } from './jobs/health-check.mjs';
import { createJobStore } from './jobs/store.mjs';

const config = loadJobsConfig();
const store = createJobStore(config.jobsDbPath);
try {
  const { findings, opened, alerted, desktop } = runHealthCheck({
    store, config, notify: !process.argv.includes('--no-notify'), desktopNotify: notifyMacOS,
  });
  if (!findings.length) console.log('הכול תקין: לא נמצאו בעיות שדורשות תשומת לב.');
  for (const finding of findings) {
    const fresh = opened.some((item) => item.key === finding.key) ? ' (חדש)' : '';
    console.log(`[${finding.severity}] ${finding.title}${fresh}\n  ${finding.detail || ''}`);
  }
  if (alerted) console.log('נשלחה התראה ל-WhatsApp על הבעיות החדשות.');
  if (desktop) console.log('הוצגה התראת macOS, כי ה-Collector לא מחובר ולא יכול לשלוח ב-WhatsApp.');
} finally {
  store.close();
}
