import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { createJobPageFetcher } from '../scripts/jobs/fetch-page.mjs';
import { scanLinkedIn } from '../scripts/jobs/sources/linkedin.mjs';
import { completionStatusFor, evaluateCandidates, summarizeProcessingResults } from '../scripts/jobs.mjs';

const MINUTE = 60_000;

function newStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-cooldown-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  return store;
}

test('a block pauses all LinkedIn requests; recent activity pauses only page reads', (context) => {
  const store = newStore(context);
  const at = 1_000_000;
  assert.deepEqual(store.getLinkedInCooldown({ now: at }), { scans: null, reads: null });

  store.noteLinkedInActivity(at);
  const afterActivity = store.getLinkedInCooldown({ now: at + 5 * MINUTE, afterActivityMs: 15 * MINUTE });
  assert.equal(afterActivity.scans, null, 'activity alone never stops the scheduled scan');
  assert.deepEqual(afterActivity.reads, { until: at + 15 * MINUTE, reason: 'recent_activity' });
  assert.equal(store.getLinkedInCooldown({ now: at + 16 * MINUTE, afterActivityMs: 15 * MINUTE }).reads, null);

  store.noteLinkedInBlock('rate_limited', { at, cooldownMs: 60 * MINUTE });
  const blocked = store.getLinkedInCooldown({ now: at + 30 * MINUTE, afterActivityMs: 15 * MINUTE });
  assert.deepEqual(blocked.scans, { until: at + 60 * MINUTE, reason: 'rate_limited' });
  assert.deepEqual(blocked.reads, blocked.scans);
  assert.deepEqual(store.getLinkedInCooldown({ now: at + 61 * MINUTE, afterActivityMs: 15 * MINUTE }), { scans: null, reads: null });
});

test('the fetcher sends nothing to LinkedIn during a cooldown, and reports requests and blocks', async () => {
  const requested = [];
  const memory = { getFreshPage: () => null, savePage: () => {} };
  const cooling = createJobPageFetcher({
    store: memory, cacheTtlMs: 0, now: () => 100,
    linkedinCooldown: { until: 200, reason: 'rate_limited' },
    fetchImpl: async (url) => { requested.push(url); return new Response('', { status: 200 }); },
  });
  const page = await cooling.fetch('https://www.linkedin.com/jobs/view/1111111111');
  assert.equal(page.code, 'linkedin_cooldown');
  assert.equal(page.status, 'uncertain');
  assert.equal(requested.length, 0);

  const events = [];
  const live = createJobPageFetcher({
    store: memory, cacheTtlMs: 0, now: () => 300, sleep: async () => {},
    linkedinCooldown: { until: 200, reason: 'rate_limited' },
    onLinkedInRequest: () => events.push('request'),
    onLinkedInBlock: (status) => events.push(`block:${status}`),
    fetchImpl: async () => new Response('', { status: 429 }),
  });
  assert.equal((await live.fetch('https://www.linkedin.com/jobs/view/2222222222')).code, 'linkedin_rate_limited');
  assert.deepEqual(events, ['request', 'block:rate_limited']);
});

test('a scan during a block sends no request and keeps coverage for the next run', async (context) => {
  const store = newStore(context);
  store.syncLinkedInSearches([{ key: 'backend', label: 'Backend', keywords: 'backend', location: 'Israel' }]);
  const [before] = store.listLinkedInSearches();
  store.recordLinkedInSearchAttempt({ searchId: before.id, queryHash: before.queryHash, status: 'complete', coveredUntil: 1_000 });
  let requests = 0;

  const result = await scanLinkedIn({
    config: { decision: { criteriaVersion: 'v1' }, sources: { linkedin: { enabled: true, limits: { delayMs: [0, 0] } } } },
    store, now: 5_000, sleep: async () => {},
    cooldown: { until: 10_000, reason: 'rate_limited' },
    fetchImpl: async () => { requests += 1; return { status: 200, url: '', text: async () => '' }; },
  });

  assert.equal(requests, 0);
  assert.equal(result.requests, 0);
  assert.equal(result.searches[0].status, 'failed');
  assert.equal(result.errors[0].code, 'linkedin_cooldown');
  assert.equal(store.listLinkedInSearches()[0].coveredUntil, 1_000);
});

test('a job deferred by the cooldown stays pending without an error and does not fail the run', async (context) => {
  const store = newStore(context);
  const url = 'https://www.linkedin.com/jobs/view/3333333333';
  const candidate = { ...store.recordSighting({ url, source: 'WhatsApp: Group A' }), url, source: 'WhatsApp: Group A' };
  let scored = 0;

  const outcomes = await evaluateCandidates({
    candidates: [candidate], store,
    config: { decision: { criteriaVersion: 'v1' } },
    fetcher: { fetch: async () => ({ status: 'uncertain', code: 'linkedin_cooldown', reason: 'cooling', content: '', contentHash: 'h' }) },
    scorer: { profileHash: 'p', scoreBatchSettled: async (items) => { scored += items.length; } },
  });

  assert.equal(outcomes.get(candidate.jobKey).status, 'deferred');
  assert.equal(scored, 0);
  assert.equal(store.getJob(candidate.jobKey).last_error_code, null);
  assert.deepEqual(store.listPendingEvaluation().map((job) => job.jobKey), [candidate.jobKey]);
  const processing = summarizeProcessingResults([candidate], outcomes);
  assert.equal(processing.totals.deferred, 1);
  assert.equal(processing.totals.failed, 0);
  assert.equal(completionStatusFor({ processing }), 'success');
});
