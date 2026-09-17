import fs from 'node:fs';
import path from 'node:path';

import { processState } from './diagnostics.mjs';

const MAX_LOCK_BYTES = 1_024;

function readLock(lockPath) {
  try {
    const text = fs.readFileSync(lockPath, 'utf8').slice(0, MAX_LOCK_BYTES);
    const value = JSON.parse(text);
    return Number.isInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

export function acquireSingleInstance(lockPath, {
  pid = process.pid,
  startedAt = Date.now(),
  probe = processState,
  name = 'WhatsApp collector',
  errorCode = 'JOBOPS_COLLECTOR_ALREADY_RUNNING',
  errorMessage = `${name} already running; lock already held.`,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid, startedAt }), { encoding: 'utf8' });
      fs.closeSync(handle);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const current = readLock(lockPath);
          if (current?.pid === pid) fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readLock(lockPath);
      if (current && probe(current.pid) === 'alive') {
        const lockError = new Error(errorMessage);
        lockError.code = errorCode;
        throw lockError;
      }
      // A malformed lock, or one whose process is gone, cannot own the session.
      // Remove only this exact lock file and retry the atomic create once.
      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error(`Unable to acquire ${name} lock.`);
}
