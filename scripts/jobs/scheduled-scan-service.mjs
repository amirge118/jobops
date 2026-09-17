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
];

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function renderScheduledScanAgent(schedule, { nodePath = process.execPath, rootDir = ROOT_DIR } = {}) {
  const jobsPath = path.join(rootDir, 'scripts', 'jobs.mjs');
  const intervals = schedule.times
    .map(({ hour, minute }) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`)
    .join('');
  const argsXml = schedule.args.map((arg) => `<string>${xml(arg)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(schedule.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(jobsPath)}</string>${argsXml}</array>
  <key>WorkingDirectory</key><string>${xml(rootDir)}</string>
  <key>StartCalendarInterval</key>
  <array>${intervals}</array>
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

function formatTimes(times) {
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
      console.log(`Installed ${schedule.label} (${formatTimes(schedule.times)}).`);
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
