#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { assertExternalRuntime, startLocal } from './start-local.mjs';
import { stopLocal } from './stop-local.mjs';

export async function restartLocal() {
  assertExternalRuntime();
  await stopLocal();
  return startLocal();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  restartLocal().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
