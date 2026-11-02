import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { load as parseYaml } from 'js-yaml';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PREFIX = 'com.jobops';
const SAFE_PREFIX = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

// Background service names are per machine, and an install keeps the names it
// started with: renaming would leave the old agents running next to new ones.
function labelPrefix() {
  try {
    const file = process.env.JOBOPS_JOBS_CONFIG || path.join(ROOT_DIR, 'config', 'jobs.yml');
    const prefix = parseYaml(fs.readFileSync(file, 'utf8'))?.service?.labelPrefix;
    return SAFE_PREFIX.test(prefix ?? '') ? prefix : DEFAULT_PREFIX;
  } catch {
    return DEFAULT_PREFIX;
  }
}

export function serviceLabel(name) {
  return `${labelPrefix()}.${name}`;
}
