import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SERIES, classifyPostingResponse, detectEgress, runLinkedInCanary, runLinkedInCanarySeries, summarizeCanaryLog } from '../scripts/jobs/linkedin-canary.mjs';

const posting = `<h2 class="top-card-layout__title">Backend Engineer</h2>
  <div class="show-more-less-html__markup">${'Build reliable services. '.repeat(20)}</div>`;

function fakeFetch({ status = 200, body = posting, headers = {}, url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/123' } = {}) {
  const calls = [];
  const fetchImpl = async (requested, options) => {
    calls.push({ requested, options });
    return { status, url, text: async () => body, headers: new Map(Object.entries(headers)) };
  };
  return { fetchImpl, calls };
}

test('the canary sends exactly one request and records the answer and egress, not the IP', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 429, body: '', headers: { 'retry-after': '120' } });
  const record = await runLinkedInCanary({ jobId: '4469203263', fetchImpl, egress: { warp: 'on', gateway: 'on' }, now: () => 1_000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].requested, /jobPosting\/4469203263$/);
  assert.equal(record.httpStatus, 429);
  assert.equal(record.result, 'rate_limited');
  assert.equal(record.retryAfter, '120');
  assert.deepEqual(record.egress, { warp: 'on', gateway: 'on' });
});

test('posting answers are classified the way the scanner reads them', () => {
  assert.equal(classifyPostingResponse({ status: 200, html: posting }), 'ok');
  assert.equal(classifyPostingResponse({ status: 404 }), 'not_found');
  assert.equal(classifyPostingResponse({ status: 429 }), 'rate_limited');
  assert.equal(classifyPostingResponse({ status: 999 }), 'blocked');
  assert.equal(classifyPostingResponse({ status: 200, finalUrl: 'https://www.linkedin.com/authwall?x=1', html: 'Sign in' }), 'blocked');
  assert.equal(classifyPostingResponse({ error: Object.assign(new Error('t'), { name: 'TimeoutError' }) }), 'timeout');
});

test('egress keeps only the WARP flags', async () => {
  const fetchImpl = async () => ({ text: async () => 'fl=1\nip=203.0.113.9\nloc=IL\nwarp=off\ngateway=off\n' });
  assert.deepEqual(await detectEgress(fetchImpl), { warp: 'off', gateway: 'off' });
  assert.deepEqual(await detectEgress(async () => { throw new Error('offline'); }), { warp: null, gateway: null });
});

test('the report shows, per egress, how long the current block has lasted', () => {
  const at = (hour) => new Date(Date.UTC(2026, 9, 19, hour)).toISOString();
  const summary = summarizeCanaryLog([
    { at: at(8), egress: { warp: 'on' }, result: 'ok' },
    { at: at(10), egress: { warp: 'on' }, result: 'rate_limited' },
    { at: at(13), egress: { warp: 'on' }, result: 'rate_limited' },
    { at: at(14), egress: { warp: 'off' }, result: 'ok' },
  ]);
  assert.deepEqual(summary.find((item) => item.egress === 'warp'), {
    egress: 'warp', requests: 3, counts: { ok: 1, rate_limited: 2 }, lastOkAt: at(8), blockedSince: at(10), blockedHours: 3,
  });
  assert.equal(summary.find((item) => item.egress === 'direct').blockedSince, null);
});

test('a pacing series waits the interval between requests and stops at the first refusal', async () => {
  const statuses = [200, 200, 429, 200];
  const calls = [];
  const fetchImpl = async (url) => {
    const status = statuses[calls.length];
    calls.push(url);
    return { status, url, text: async () => (status === 200 ? posting : ''), headers: new Map() };
  };
  const waits = [];
  const records = await runLinkedInCanarySeries({ jobIds: ['1', '2', '3', '4'], intervalMs: 60_000, fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(records.map((record) => record.result), ['ok', 'ok', 'rate_limited']);
  assert.equal(calls.length, 3, 'nothing is sent after the refusal');
  assert.deepEqual(waits, [60_000, 60_000]);
  assert.deepEqual(records.map((record) => record.series), [0, 1, 2].map((index) => ({ intervalMs: 60_000, index })));

  const many = await runLinkedInCanarySeries({ jobIds: Array.from({ length: 30 }, (_, i) => String(i)), intervalMs: 1, fetchImpl: fakeFetch().fetchImpl, sleep: async () => {} });
  assert.equal(many.length, MAX_SERIES, 'a series is capped');
});
