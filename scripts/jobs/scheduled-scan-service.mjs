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
function hourly({ from, to, minute, every = 1 }) {
  const times = [];
  for (let hour = from; hour <= to; hour += every) times.push({ hour, minute });
  return times;
}

export const SCHEDULES = [
  // Hourly through the working day: a company's own board is where a job
  // appears first, and polling its public ATS API costs no tokens (Codex only
  // scores new titles that pass the filters). :05 stays off the other slots.
  {
    key: 'ats',
    label: 'com.amirgefen.jobops.scan-ats',
    args: ['--ats-only', '--wait-for-lock', '20'],
    times: hourly({ from: 8, to: 21, minute: 5 }),
  },
  {
    key: 'whatsapp',
    label: 'com.amirgefen.jobops.scan-whatsapp',
    args: ['--whatsapp-only'],
    times: [{ hour: 10, minute: 0 }, { hour: 15, minute: 0 }, { hour: 20, minute: 0 }],
  },
  // Every two hours, off the WhatsApp and ATS slots. Short windows mean few
  // pages per run, so the total request count stays close to the old three
  // long runs a day. Each search resumes from its own last success, so a
  // missed slot is caught up rather than lost; the cross-run cooldown skips
  // runs after a block. Waiting up to 20 minutes for the scan lock turns a
  // rare collision into a short delay.
  {
    key: 'linkedin',
    label: 'com.amirgefen.jobops.scan-linkedin',
    args: ['--linkedin-only', '--wait-for-lock', '20'],
    times: hourly({ from: 8, to: 22, minute: 30, every: 2 }),
  },
  // Daily resolution of candidate companies: each one either starts being
  // watched (a source with jobs that evidently belongs to it) or moves to the
  // companies page's "cannot be scanned" list with a reason. Renders careers
  // pages in a headless browser; Codex only researches never-researched ones.
  {
    key: 'companies',
    label: 'com.amirgefen.jobops.resolve-companies',
    script: ['scripts', 'jobs', 'company-auto-resolve.mjs'],
    args: [],
    times: [{ hour: 13, minute: 20 }],
  },
  // Token-free health check (scripts/jobs/health-check.mjs) at :50, after the
  // hourly ATS run: stores what needs attention for the scan page and sends a
  // WhatsApp alert only for problems that are new since the last check.
  {
    key: 'health',
    label: 'com.amirgefen.jobops.health-check',
    script: ['scripts', 'health-check.mjs'],
    args: [],
    times: hourly({ from: 9, to: 22, minute: 50 }),
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
  // Without a log, a skipped or failed scheduled run leaves no trace at all.
  const logPath = scheduleLogPath(schedule, rootDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(schedule.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(jobsPath)}</string>${argsXml}</array>
  <key>WorkingDirectory</key><string>${xml(rootDir)}</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  ${trigger}
</dict>
</plist>
`;
}

export function scheduleLogPath(schedule, rootDir = ROOT_DIR) {
  return path.join(rootDir, 'logs', 'scheduled', `${schedule.key}.log`);
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
      fs.mkdirSync(path.dirname(scheduleLogPath(schedule)), { recursive: true });
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
