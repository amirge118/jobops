#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DASHBOARD_PORT, stopDashboard } from './local-dashboard-process.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function stopLocal() {
  const result = await stopDashboard({ rootDir: ROOT_DIR });
  if (result.status === 'not_running') {
    console.log(`jobOps dashboard is not running on port ${DASHBOARD_PORT}.`);
  } else {
    const forced = result.forced.length ? ' (force-stopped after a graceful timeout)' : '';
    console.log(`jobOps dashboard stopped on port ${DASHBOARD_PORT}${forced}.`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  stopLocal().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
