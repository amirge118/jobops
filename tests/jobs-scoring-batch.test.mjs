import './helpers/stdout-safe-console.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { evaluateCandidates, scoringDeferral, summarizeProcessingResults, completionStatusFor } from '../scripts/jobs.mjs';

const HOUR = 60 * 60 * 1000;
const config = { decision: { criteriaVersion: 'v1' }, scoring: { minBatch: 3, maxWaitHours: 2 } };

test('scoring waits for a batch unless the oldest job has waited long enough', () => {
  const now = 10 * HOUR;
  assert.equal(scoringDeferral({ count: 2, oldestFirstSeenAt: now - HOUR, now, config }).defer, true);
  assert.equal(scoringDeferral({ count: 3, oldestFirstSeenAt: now - HOUR, now, config }).defer, false, 'a full batch scores');
  assert.equal(scoringDeferral({ count: 1, oldestFirstSeenAt: now - 2 * HOUR, now, config }).defer, false, 'waited long enough');
  assert.equal(scoringDeferral({ count: 0, oldestFirstSeenAt: now, now, config }).defer, false);
  assert.equal(scoringDeferral({ count: 1, oldestFirstSeenAt: now, now, config: { scoring: {} } }).defer, false,
    'without minBatch nothing is deferred');
});

function setup(context, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-batch-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const candidates = Array.from({ length: count }, (_, index) => {
    const url = `https://jobs.example.com/${index + 1}`;
    return { ...store.recordSighting({ url, company: 'Acme', title: `Backend ${index + 1}`, source: 'ATS: Acme' }), url, source: 'ATS: Acme' };
  });
  const scored = [];
  const deps = {
    candidates, store, config,
    fetcher: { fetch: async (url) => ({ status: 'active', content: `page ${url}`, contentHash: url, finalUrl: url }) },
    scorer: { profileHash: 'p', scoreBatchSettled: async (items) => { scored.push(items.length); } },
  };
  return { store, candidates, scored, deps };
}

test('an unattended run with too few jobs leaves them pending without error, for the next run', async (context) => {
  const { store, candidates, scored, deps } = setup(context, 2);
  const outcomes = await evaluateCandidates({ ...deps, allowDeferScoring: true });

  assert.deepEqual(scored, [], 'no Codex call');
  assert.deepEqual(candidates.map((candidate) => outcomes.get(candidate.jobKey).status), ['deferred', 'deferred']);
  assert.deepEqual(store.listPendingEvaluation().map((job) => job.jobKey).sort(), candidates.map((c) => c.jobKey).sort());
  assert.ok(candidates.every((candidate) => store.getJob(candidate.jobKey).last_error_code === null));
  const processing = summarizeProcessingResults(candidates, outcomes);
  assert.equal(completionStatusFor({ processing }), 'success', 'deferring is not a failure');
});

test('a full batch, or a run someone waits on, scores immediately', async (context) => {
  const full = setup(context, 3);
  await evaluateCandidates({ ...full.deps, allowDeferScoring: true });
  assert.deepEqual(full.scored, [3]);

  const manual = setup(context, 1);
  await evaluateCandidates({ ...manual.deps, allowDeferScoring: false });
  assert.deepEqual(manual.scored, [1]);
});

test('a lone job is scored once it has waited maxWaitHours', async (context) => {
  const { scored, deps } = setup(context, 1);
  await evaluateCandidates({ ...deps, allowDeferScoring: true, now: () => Date.now() + 3 * HOUR });
  assert.deepEqual(scored, [1]);
});
