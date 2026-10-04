import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-personal-area-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

test('gap term statuses: set, keyed by the aggregation term key, and cleared', () => {
  const store = newStore();
  store.setGapTermStatus('Prompt Engineering', 'in_progress', 100);
  store.setGapTermStatus('IVR', 'hidden', 200);
  // Another spelling of the same term updates the one row.
  store.setGapTermStatus('prompt-engineering', 'hidden', 300);

  assert.deepEqual(store.listGapTermStatuses().map(({ termKey, status }) => [termKey, status]).sort(), [
    ['ivr', 'hidden'],
    ['promptengineering', 'hidden'],
  ]);

  assert.equal(store.setGapTermStatus('IVR', null), null);
  assert.deepEqual(store.listGapTermStatuses().map((row) => row.termKey), ['promptengineering']);
  store.close();
});

test('gap term statuses: reject unknown statuses and empty terms', () => {
  const store = newStore();
  assert.throws(() => store.setGapTermStatus('Go', 'done'), /Unknown gap term status/);
  assert.throws(() => store.setGapTermStatus(' / ', 'hidden'), /term is required/);
  store.close();
});
