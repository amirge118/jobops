#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startDashboard } from './web.mjs';
import { loadJobsConfig } from './jobs/config.mjs';
import { createJobStore } from './jobs/store.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTOR_SERVICE = path.join(ROOT_DIR, 'scripts', 'jobs', 'collector-service.mjs');

export function assertExternalRuntime(env = process.env) {
  if (env.CODEX_SANDBOX || env.CODEX_PERMISSION_PROFILE) {
    throw new Error('Run npm run start:local from the macOS Terminal app, not from a Codex terminal.');
  }
}

function collectorCommand(command, stdio) {
  return spawnSync(process.execPath, [COLLECTOR_SERVICE, command], {
    cwd: ROOT_DIR,
    stdio,
  });
}

export function collectorNeedsRestart({ serviceLoaded, collector } = {}) {
  return !serviceLoaded || collector?.status !== 'connected';
}

function latestCollector() {
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  try { return store.getCollectorStatusSummary(); }
  finally { store.close(); }
}

export async function startLocal() {
  assertExternalRuntime();
  const status = collectorCommand('status', 'ignore');
  const collector = latestCollector();
  if (collectorNeedsRestart({ serviceLoaded: status.status === 0, collector })) {
    const reason = status.status !== 0
      ? 'the background service is not loaded'
      : `the latest Collector is ${collector?.status || 'missing'}`;
    console.log(`WhatsApp Collector needs repair because ${reason}; restarting it...`);
    const install = collectorCommand('install', 'inherit');
    if (install.status !== 0) {
      console.warn('WhatsApp Collector repair failed. The dashboard will still start so ATS remains available.');
    }
  } else {
    console.log('WhatsApp Collector is connected.');
  }
  return startDashboard(['--open']);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startLocal().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
