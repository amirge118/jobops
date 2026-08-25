#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import { canonicalizeJobUrl, deduplicateJobs } from './core.mjs';
import { createJobStore } from './store.mjs';

export async function openJobUrls({
  jobs,
  application = 'Google Chrome',
  platform = process.platform,
  spawnProcess = spawn,
}) {
  const validJobs = jobs.filter((job) => canonicalizeJobUrl(job.applyUrl));
  if (validJobs.length === 0) return { opened: 0, jobKeys: [] };
  if (platform !== 'darwin') throw new Error('Opening job URLs is currently supported on macOS only.');

  const args = ['-a', application, ...validJobs.map((job) => job.applyUrl)];
  await new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/open', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Chrome opener exited with code ${code}`)));
  });

  return { opened: validJobs.length, jobKeys: validJobs.map((job) => job.jobKey) };
}

async function main() {
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  try {
    const unopenedJobs = store.listUnopenedSuitable();
    const jobs = deduplicateJobs(unopenedJobs);
    const result = await openJobUrls({ jobs, application: config.browser?.application });
    if (result.opened > 0) store.markOpened(unopenedJobs.map((job) => job.jobKey));
    console.log(result.opened > 0
      ? `נפתחו ${result.opened} משרות חדשות ב-${config.browser?.application || 'Google Chrome'}.`
      : 'אין משרות מתאימות חדשות לפתיחה.');
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`שגיאה בפתיחת משרות: ${error.message}`);
    process.exitCode = 1;
  });
}
