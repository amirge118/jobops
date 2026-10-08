#!/usr/bin/env node

// Scheduled, token-free health check (scripts/jobs/health-check.mjs): stores
// what needs attention for the scan page and alerts on WhatsApp about new
// problems. Also runnable by hand:
//
//   npm run jobs:health-check               # check, store, alert on new findings
//   npm run jobs:health-check -- --no-notify

import { loadJobsConfig } from './jobs/config.mjs';
import { runHealthCheck } from './jobs/health-check.mjs';
import { createJobStore } from './jobs/store.mjs';

const config = loadJobsConfig();
const store = createJobStore(config.jobsDbPath);
try {
  const { findings, opened, alerted } = runHealthCheck({ store, config, notify: !process.argv.includes('--no-notify') });
  if (!findings.length) console.log('הכול תקין: לא נמצאו בעיות שדורשות תשומת לב.');
  for (const finding of findings) {
    const fresh = opened.some((item) => item.key === finding.key) ? ' (חדש)' : '';
    console.log(`[${finding.severity}] ${finding.title}${fresh}\n  ${finding.detail || ''}`);
  }
  if (alerted) console.log('נשלחה התראה ל-WhatsApp על הבעיות החדשות.');
} finally {
  store.close();
}
