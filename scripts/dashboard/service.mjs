#!/usr/bin/env node

// The dashboard as a LaunchAgent: it starts at login and comes back after a
// crash, instead of living in whichever terminal tab started it (closing the
// tab used to take the dashboard down with it). Once installed,
// start/stop/restart:local manage it through launchctl rather than signals,
// which launchd's KeepAlive would otherwise undo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DASHBOARD_PORT, findDashboardPids, stopDashboard } from '../local-dashboard-process.mjs';

export const DASHBOARD_LABEL = 'com.amirgefen.jobops.dashboard';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DASHBOARD_LABEL}.plist`);

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

// No --open: a login-time start must not pop up a browser window.
export function renderDashboardAgent({ nodePath = process.execPath, rootDir = ROOT_DIR } = {}) {
  const logPath = path.join(rootDir, 'logs', 'dashboard.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DASHBOARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>${xml(path.join(rootDir, 'scripts', 'web.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(rootDir)}</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', stdio: 'pipe' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed (${result.status}): ${(result.stderr || '').trim()}. Run it from the macOS Terminal app.`);
  }
  return result;
}

const domain = () => `gui/${process.getuid()}`;

export function dashboardServiceInstalled() {
  return fs.existsSync(PLIST_PATH);
}

async function waitForPort(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findDashboardPids(DASHBOARD_PORT).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Unload the service first (signalling its process would only make KeepAlive
// revive it), then stop a dashboard started by hand that would hold the port.
export async function startDashboardService() {
  launchctl(['bootout', domain(), PLIST_PATH], { allowFailure: true });
  await stopDashboard({ rootDir: ROOT_DIR });
  launchctl(['bootstrap', domain(), PLIST_PATH]);
  if (!await waitForPort()) {
    throw new Error(`The dashboard service did not open port ${DASHBOARD_PORT}; see logs/dashboard.log.`);
  }
}

export function stopDashboardService() {
  launchctl(['bootout', domain(), PLIST_PATH], { allowFailure: true });
}

export async function manageDashboardService(command = process.argv[2]) {
  if (command === 'install') {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.mkdirSync(path.join(ROOT_DIR, 'logs'), { recursive: true });
    fs.writeFileSync(PLIST_PATH, renderDashboardAgent(), { mode: 0o644 });
    fs.chmodSync(PLIST_PATH, 0o644);
    await startDashboardService();
    console.log(`Installed ${DASHBOARD_LABEL}: the dashboard now starts at login and restarts after a crash.`);
    return;
  }
  if (command === 'uninstall') {
    stopDashboardService();
    fs.rmSync(PLIST_PATH, { force: true });
    console.log(`Uninstalled ${DASHBOARD_LABEL}. npm run start:local runs the dashboard in the terminal again.`);
    return;
  }
  if (command === 'status') {
    const result = launchctl(['print', `${domain()}/${DASHBOARD_LABEL}`], { allowFailure: true });
    console.log(result.status === 0 ? result.stdout : `${DASHBOARD_LABEL} is not loaded.`);
    process.exitCode = result.status === 0 ? 0 : 1;
    return;
  }
  throw new Error('Use: service.mjs install | uninstall | status');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  manageDashboardService().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
