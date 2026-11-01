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

test('gap term statuses: set, keyed by the aggregation term key, and cleared', async () => {
  const store = newStore();
  await store.setGapTermStatus('Prompt Engineering', 'in_progress', 100);
  await store.setGapTermStatus('IVR', 'hidden', 200);
  // Another spelling of the same term updates the one row.
  await store.setGapTermStatus('prompt-engineering', 'hidden', 300);

  assert.deepEqual((await store.listGapTermStatuses()).map(({ termKey, status }) => [termKey, status]).sort(), [
    ['ivr', 'hidden'],
    ['promptengineering', 'hidden'],
  ]);

  assert.equal(await store.setGapTermStatus('IVR', null), null);
  assert.deepEqual((await store.listGapTermStatuses()).map((row) => row.termKey), ['promptengineering']);
  store.close();
});

test('gap term statuses: reject unknown statuses and empty terms', async () => {
  const store = newStore();
  await assert.rejects(async () => await store.setGapTermStatus('Go', 'done'), /Unknown gap term status/);
  await assert.rejects(async () => await store.setGapTermStatus(' / ', 'hidden'), /term is required/);
  store.close();
});
