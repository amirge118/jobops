#!/usr/bin/env node

// Opens a plain Google Chrome window (no automation: Google sign-in refuses an
// automated browser) on HireMeTech with the scanner's own profile
// (auth/hiremetech, not your everyday Chrome profile). You sign in there
// yourself — this script never sees or types a password — and quit that
// window (Cmd+Q). The script then checks, headlessly, that the profile is
// signed in by asking the API for a sample job's employer.

import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import {
  HIREMETECH_ORIGIN, hireMeTechProfilePath, hireMeTechTarget, launchHireMeTechContext, openHireMeTechApiPage, readApiJob,
} from './hiremetech-resolve.mjs';

const PROBE_JOB_ID = '151968448';
const POLL_MS = 3_000;
const TIMEOUT_MS = 15 * 60_000;

const profileOpen = (profilePath) =>
  spawnSync('/usr/bin/pgrep', ['-f', `--user-data-dir=${profilePath}`], { encoding: 'utf8' }).status === 0;

export async function checkHireMeTechSession(profilePath, jobId = PROBE_JOB_ID) {
  const context = await launchHireMeTechContext(profilePath);
  try {
    const page = await openHireMeTechApiPage(context);
    const { signedIn, job } = await readApiJob(page, jobId);
    return { signedIn, target: hireMeTechTarget(job) };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const config = loadJobsConfig();
  const profilePath = hireMeTechProfilePath(config);
  if (!argv.includes('--check')) {
    if (profileOpen(profilePath)) throw new Error('חלון Chrome של פרופיל הסורק כבר פתוח. סגור אותו (Cmd+Q) והרץ שוב.');
    spawn('/usr/bin/open', ['-na', 'Google Chrome', '--args', `--user-data-dir=${profilePath}`, '--no-first-run', HIREMETECH_ORIGIN],
      { stdio: 'ignore', detached: true }).unref();
    console.log('נפתח חלון Chrome נפרד על HireMeTech. התחבר בו (גם עם Google), ואז סגור את החלון הזה עם Cmd+Q.');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const deadline = Date.now() + TIMEOUT_MS;
    while (profileOpen(profilePath)) {
      if (Date.now() > deadline) throw new Error('החלון עדיין פתוח אחרי 15 דקות. סגור אותו והרץ npm run jobs:hiremetech-login -- --check.');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  const { signedIn, target } = await checkHireMeTechSession(profilePath);
  if (!signedIn || target.masked) throw new Error('הפרופיל לא מחובר ל-HireMeTech. הרץ שוב והתחבר בחלון שנפתח.');
  console.log(`מחובר. משרה ${PROBE_JOB_ID}: חברה "${target.company}".`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`התחברות ל-HireMeTech נכשלה: ${error.message}`);
      process.exit(1);
    });
}
