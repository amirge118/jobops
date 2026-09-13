#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'com.amirgefen.jobops.whatsapp-collector';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function renderLaunchAgent({ nodePath = process.execPath, rootDir = ROOT_DIR } = {}) {
  const collectorPath = path.join(rootDir, 'scripts', 'jobs', 'whatsapp-collector.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(collectorPath)}</string></array>
  <key>WorkingDirectory</key><string>${xml(rootDir)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>JOBOPS_HIDE_QR</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', stdio: allowFailure ? 'pipe' : 'inherit' });
  if (!allowFailure && result.status !== 0) {
    const hint = result.status === 5
      ? 'The plist was created, but this host could not register it. Run npm run whatsapp:collector:install once from the macOS Terminal app.'
      : `launchctl failed with exit code ${result.status}`;
    throw new Error(hint);
  }
  return result;
}

export function manageCollectorService(command = process.argv[2]) {
  const domain = `gui/${process.getuid()}`;
  if (command === 'install') {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, renderLaunchAgent(), { mode: 0o644 });
    fs.chmodSync(PLIST_PATH, 0o644);
    launchctl(['bootout', domain, PLIST_PATH], { allowFailure: true });
    launchctl(['bootstrap', domain, PLIST_PATH]);
    console.log(`Installed ${LABEL}. Diagnostics are stored in data/jobs.db.`);
    return;
  }
  if (command === 'uninstall') {
    launchctl(['bootout', domain, PLIST_PATH], { allowFailure: true });
    fs.rmSync(PLIST_PATH, { force: true });
    console.log(`Uninstalled ${LABEL}. Local database and WhatsApp auth were preserved.`);
    return;
  }
  if (command === 'status') {
    const result = launchctl(['print', `${domain}/${LABEL}`], { allowFailure: true });
    console.log(result.status === 0 ? result.stdout : `${LABEL} is not loaded.`);
    process.exitCode = result.status === 0 ? 0 : 1;
    return;
  }
  throw new Error('Use: collector-service.mjs install | uninstall | status');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { manageCollectorService(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
