#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each schedule becomes its own LaunchAgent: a single StartCalendarInterval
// array always fires the same fixed ProgramArguments, so a source that runs
// at several times a day (WhatsApp) and one that runs once (ATS) need
// separate agents even though both just invoke the same jobs.mjs CLI.
// Neither passes --open: unattended runs should leave new matches for
// review on /decisions, not flood Chrome with tabs while no one is looking.
export const SCHEDULES = [
  {
    key: 'ats',
    label: 'com.amirgefen.jobops.scan-ats',
    args: ['--ats-only'],
    times: [{ hour: 14, minute: 0 }],
  },
  {
    key: 'whatsapp',
    label: 'com.amirgefen.jobops.scan-whatsapp',
    args: ['--whatsapp-only'],
    times: [{ hour: 10, minute: 0 }, { hour: 15, minute: 0 }, { hour: 20, minute: 0 }],
  },
  // Off the WhatsApp slots on purpose. Normal windows are ~11.5h / 4.5h /
  // 8h, covering the full day; each search resumes from its own last
  // success, so a missed slot is caught up rather than lost. Waiting up to
  // 20 minutes for the scan lock turns a rare collision into a short delay.
  {
    key: 'linkedin',
    label: 'com.amirgefen.jobops.scan-linkedin',
    args: ['--linkedin-only', '--wait-for-lock', '20'],
    times: [{ hour: 8, minute: 0 }, { hour: 12, minute: 30 }, { hour: 20, minute: 30 }],
  },
  // A token-free check every 30 minutes: it processes the locally collected
  // WhatsApp backlog only once enough new jobs are waiting, or once the
  // oldest has waited long enough (see scripts/jobs/whatsapp-trigger.mjs).
  {
    key: 'whatsapp-trigger',
    label: 'com.amirgefen.jobops.whatsapp-trigger',
    script: ['scripts', 'jobs', 'whatsapp-trigger.mjs'],
    args: [],
    intervalSeconds: 1800,
  },
];

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function renderScheduledScanAgent(schedule, { nodePath = process.execPath, rootDir = ROOT_DIR } = {}) {
  const jobsPath = path.join(rootDir, ...(schedule.script || ['scripts', 'jobs.mjs']));
  const trigger = schedule.intervalSeconds
    ? `<key>StartInterval</key><integer>${Number(schedule.intervalSeconds)}</integer>`
    : `<key>StartCalendarInterval</key>
  <array>${schedule.times
    .map(({ hour, minute }) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`)
    .join('')}</array>`;
  const argsXml = schedule.args.map((arg) => `<string>${xml(arg)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(schedule.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(jobsPath)}</string>${argsXml}</array>
  <key>WorkingDirectory</key><string>${xml(rootDir)}</string>
  ${trigger}
</dict>
</plist>
`;
}

function plistPathFor(label) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', stdio: allowFailure ? 'pipe' : 'inherit' });
  if (!allowFailure && result.status !== 0) {
    const hint = result.status === 5
      ? 'The plist was created, but this host could not register it. Run npm run jobs:schedule:install once from the macOS Terminal app.'
      : `launchctl failed with exit code ${result.status}`;
    throw new Error(hint);
  }
  return result;
}

function formatTimes(times, intervalSeconds) {
  if (intervalSeconds) return `every ${Math.round(intervalSeconds / 60)} minutes`;
  return times.map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join(', ');
}

export function manageScheduledScans(command = process.argv[2]) {
  const domain = `gui/${process.getuid()}`;
  if (command === 'install') {
    for (const schedule of SCHEDULES) {
      const target = plistPathFor(schedule.label);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderScheduledScanAgent(schedule), { mode: 0o644 });
      fs.chmodSync(target, 0o644);
      launchctl(['bootout', domain, target], { allowFailure: true });
      launchctl(['bootstrap', domain, target]);
      console.log(`Installed ${schedule.label} (${formatTimes(schedule.times, schedule.intervalSeconds)}).`);
    }
    return;
  }
  if (command === 'uninstall') {
    for (const schedule of SCHEDULES) {
      const target = plistPathFor(schedule.label);
      launchctl(['bootout', domain, target], { allowFailure: true });
      fs.rmSync(target, { force: true });
      console.log(`Uninstalled ${schedule.label}.`);
    }
    return;
  }
  if (command === 'status') {
    let allLoaded = true;
    for (const schedule of SCHEDULES) {
      const result = launchctl(['print', `${domain}/${schedule.label}`], { allowFailure: true });
      if (result.status !== 0) allLoaded = false;
      console.log(result.status === 0 ? result.stdout : `${schedule.label} is not loaded.`);
    }
    process.exitCode = allLoaded ? 0 : 1;
    return;
  }
  throw new Error('Use: scheduled-scan-service.mjs install | uninstall | status');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { manageScheduledScans(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
