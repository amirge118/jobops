import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  checkCodexQuota, parseCodexJsonl, parseUsageLimitReset, resetInMemoryQuota, setCodexUsageRecorder,
} from '../scripts/jobs/llm-usage.mjs';
import { runCodexExec } from '../scripts/jobs/score-job.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { inspectRuntimeReadiness } from '../scripts/dashboard/readiness.mjs';
import { summarizeRunUsage } from '../scripts/jobs.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-llm-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

const LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:43 PM.";

function jsonlOk(answer, usage = { input_tokens: 5200, cached_input_tokens: 3000, output_tokens: 800, reasoning_output_tokens: 300 }) {
  return [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: JSON.stringify(answer) } },
    { type: 'turn.completed', usage },
  ].map((event) => JSON.stringify(event)).join('\n');
}

function fakeSpawn(stdout, exitCode = 0, calls = []) {
  return (binary, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end(stdout); child.stderr.end(); child.emit('exit', exitCode); });
    return child;
  };
}

test('codex --json output yields the structured answer and its token usage', () => {
  const parsed = parseCodexJsonl(jsonlOk({ results: [] }));
  assert.equal(parsed.message, '{"results":[]}');
  assert.deepEqual(parsed.usage, { inputTokens: 5200, cachedInputTokens: 3000, outputTokens: 800, reasoningTokens: 300 });
  assert.deepEqual(parseCodexJsonl('{"results":[]}'), { message: '{"results":[]}', usage: null, error: null, events: false });
  const failed = parseCodexJsonl([{ type: 'error', message: LIMIT }, { type: 'turn.failed', error: { message: LIMIT } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(failed.error, LIMIT);
  assert.equal(failed.message, null);
});

test('the usage-limit reset time is read from the Codex message', () => {
  const now = new Date(2026, 8, 29, 9, 0).getTime();
  assert.equal(parseUsageLimitReset(LIMIT, now), new Date(2026, 8, 29, 13, 43).getTime());
  assert.equal(parseUsageLimitReset('try again at 8:15 AM', now), new Date(2026, 8, 30, 8, 15).getTime(), 'a past time means tomorrow');
  assert.equal(parseUsageLimitReset('try again in 2 hours 30 minutes', now), now + 150 * 60_000);
  assert.equal(parseUsageLimitReset('limit reached', now), now + 60 * 60_000);
});

test('each Codex call is reported with purpose, model, items and tokens', async () => {
  resetInMemoryQuota();
  const reports = [];
  const calls = [];
  setCodexUsageRecorder((entry) => reports.push(entry));
  try {
    const answer = await runCodexExec({
      prompt: 'x', schemaPath: '/tmp/s.json', cwd: '/tmp', binary: '/tmp/codex', model: 'gpt-reserve',
      reasoningEffort: 'low', purpose: 'scoring', items: 5, spawnProcess: fakeSpawn(jsonlOk({ results: [1] }), 0, calls),
    });
    assert.deepEqual(answer, { results: [1] });
    assert.ok(calls[0].includes('--json'));
    assert.deepEqual(calls[0].slice(calls[0].indexOf('--model'), calls[0].indexOf('--model') + 4), ['--model', 'gpt-reserve', '-c', 'model_reasoning_effort="low"']);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].purpose, 'scoring');
    assert.equal(reports[0].model, 'gpt-reserve');
    assert.equal(reports[0].items, 5);
    assert.equal(reports[0].ok, true);
    assert.equal(reports[0].usage.inputTokens, 5200);
  } finally {
    setCodexUsageRecorder(null);
  }
});

test('after a usage-limit failure the same process makes no further Codex calls', async () => {
  resetInMemoryQuota();
  const reports = [];
  const calls = [];
  setCodexUsageRecorder((entry) => reports.push(entry));
  const limited = [{ type: 'error', message: LIMIT }, { type: 'turn.failed', error: { message: LIMIT } }].map((e) => JSON.stringify(e)).join('\n');
  try {
    await assert.rejects(runCodexExec({ prompt: 'x', schemaPath: '/s', cwd: '/tmp', binary: '/c', spawnProcess: fakeSpawn(limited, 1, calls) }), /usage limit/);
    await assert.rejects(runCodexExec({ prompt: 'x', schemaPath: '/s', cwd: '/tmp', binary: '/c', spawnProcess: fakeSpawn(jsonlOk({}), 0, calls) }), /usage limit/);
    assert.equal(calls.length, 1, 'the second call never spawned Codex');
    assert.equal(reports[0].errorCode, 'codex_usage_limit');
    assert.ok(reports[0].limitUntil > Date.now());
  } finally {
    setCodexUsageRecorder(null);
    resetInMemoryQuota();
  }
});

test('calls are stored and summarized per purpose and per run, and quota state follows them', () => {
  const store = tempStore();
  const runId = store.startRun({ fromTs: 1, toTs: 2, sources: ['whatsapp'] });
  const usage = { inputTokens: 6000, cachedInputTokens: 2000, outputTokens: 1000, reasoningTokens: 400 };
  store.recordCodexCall({ runId, purpose: 'scoring', model: 'gpt-reserve', items: 5, usage, ok: true, at: 1_000 });
  store.recordCodexCall({ runId, purpose: 'resume_gap', model: 'gpt-reserve', items: 2, usage, ok: true, at: 2_000 });
  store.recordCodexCall({ runId, purpose: 'scoring', items: 5, ok: false, errorCode: 'codex_usage_limit', limitUntil: 99_000, at: 3_000 });
  const summary = store.summarizeCodexUsage({ sinceMs: 0, untilMs: 10_000 });
  const scoring = summary.totals.find((row) => row.purpose === 'scoring');
  assert.equal(scoring.calls, 2);
  assert.equal(scoring.limited, 1);
  assert.equal(scoring.items, 10);
  assert.equal(scoring.inputTokens, 6000);
  assert.deepEqual(summary.runs.map((row) => [row.runId, row.calls, row.totalTokens]), [[runId, 3, 14_000]]);
  assert.equal(summary.quota.blockedUntil, 99_000);
  const run = summarizeRunUsage(summary.totals);
  assert.equal(run.totalTokens, 14_000);
  assert.equal(run.limitedCalls, 1);
  assert.equal(run.tokensPerScoredJob, 700);
  store.recordCodexCall({ purpose: 'probe', ok: true, at: 100_000 });
  assert.equal(store.getLlmQuota().blockedUntil, null, 'a successful call clears the block');
  store.close();
});

test('the quota check uses only recorded evidence and never spends a call', () => {
  resetInMemoryQuota();
  const store = tempStore();
  const now = 10_000_000;
  assert.deepEqual(checkCodexQuota({ store, now }), { available: true, basis: 'unknown' });
  store.setLlmBlocked({ until: now + 60_000, at: now });
  assert.deepEqual(checkCodexQuota({ store, now }), { available: false, until: now + 60_000, basis: 'stored' });
  resetInMemoryQuota();
  assert.equal(checkCodexQuota({ store, now: now + 120_000 }).available, true, 'a block ends at its reset time');
  store.noteLlmSuccess(now + 130_000);
  assert.deepEqual(checkCodexQuota({ store, now: now + 140_000 }), { available: true, basis: 'recent_success' });
  store.close();
  resetInMemoryQuota();
});

test('the dashboard readiness shows an exhausted quota as a blocked scorer', async () => {
  const readiness = await inspectRuntimeReadiness({
    config: {}, env: {}, now: 1_000,
    probeBrowser: async () => {}, probeCodexState: async () => {},
    readQuota: () => ({ blockedUntil: 5_000 }),
  });
  assert.equal(readiness.scorer.status, 'blocked');
  assert.equal(readiness.scorer.code, 'llm_quota_exhausted');
  assert.equal(readiness.readyFor.linkedin, false);
});

test('daily usage splits each call among the sources of the jobs in its batch', async () => {
  const { israelDay, sourceMixOf } = await import('../scripts/jobs/store.mjs');
  const store = tempStore();
  // 21:30 UTC on Sep 28 is already Sep 29 in Israel (UTC+3).
  const now = Date.UTC(2026, 8, 29, 10, 0);
  const lateNight = Date.UTC(2026, 8, 28, 21, 30);
  assert.equal(israelDay(lateNight), '2026-09-29');
  assert.deepEqual(sourceMixOf(['LinkedIn: Backend', 'LinkedIn: Backend', 'WhatsApp: A', 'ATS: lever-api', 'retry']),
    { linkedin: 2, whatsapp: 1, ats: 1, other: 1 });

  const usage = (input, output) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0 });
  store.recordCodexCall({ purpose: 'scoring', items: 5, usage: usage(8000, 2000), ok: true, at: lateNight,
    sourceMix: { linkedin: 3, whatsapp: 2 } });
  store.recordCodexCall({ purpose: 'resume_gap', items: 1, usage: usage(3000, 1000), ok: true, at: now, sourceMix: { whatsapp: 1 } });
  store.recordCodexCall({ purpose: 'probe', usage: usage(500, 10), ok: true, at: now });
  store.recordCodexCall({ purpose: 'scoring', items: 2, usage: usage(1000, 0), ok: true, at: now });
  store.recordSourceOutcome({ source: 'linkedin', suitable: true, at: now });
  store.recordSourceOutcome({ source: 'linkedin', suitable: false, at: now });
  store.recordSourceOutcome({ source: 'whatsapp', suitable: true, at: now });

  const { days, rows } = store.dailyUsageBySource({ days: 2, now });
  assert.deepEqual(days, ['2026-09-29', '2026-09-28']);
  const today = Object.fromEntries(rows.filter((row) => row.day === '2026-09-29').map((row) => [row.source, row]));
  assert.equal(today.linkedin.tokens, 6000);
  assert.equal(today.whatsapp.tokens, 4000 + 4000);
  assert.equal(today.system.tokens, 510);
  assert.equal(today.unclassified.tokens, 1000);
  assert.deepEqual([today.linkedin.scored, today.linkedin.suitable, today.linkedin.tokensPerSuitable], [2, 1, 6000]);
  assert.equal(today.whatsapp.tokensPerSuitable, 8000);
  store.close();
});

test('the dashboard serves daily usage by source for the statistics page', async (context) => {
  const { createDashboardServer } = await import('../scripts/web.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-llm-api-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { rootDir: dir, jobsDbPath: path.join(dir, 'jobs.db'), scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    sources: { whatsapp: { groups: [] } }, scoring: { model: 'gpt-reserve' } };
  const store = createJobStore(config.jobsDbPath);
  store.recordCodexCall({ purpose: 'scoring', items: 1, usage: { inputTokens: 100, outputTokens: 20 }, ok: true, sourceMix: { ats: 1 } });
  store.close();
  const server = createDashboardServer({ config, readiness: { inspect: async () => ({ readyFor: {} }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.close(); setCodexUsageRecorder(null); });
  const body = await fetch(`http://127.0.0.1:${server.address().port}/api/llm-usage/daily?days=7`).then((response) => response.json());
  assert.equal(body.model, 'gpt-reserve');
  assert.equal(body.days.length, 7);
  assert.deepEqual(body.rows.map((row) => [row.source, row.tokens]), [['ats', 120]]);
  const html = fs.readFileSync(new URL('../web/decision-stats.html', import.meta.url), 'utf8');
  assert.match(html, /id="llm-daily-body"/);
  assert.match(html, /\/pages\/llm-usage-section\.js/);
});

test('scoring calls run lean (task-only instructions, agent tools off); browsing calls keep the full agent', async () => {
  resetInMemoryQuota();
  const { LEAN_INSTRUCTIONS_PATH } = await import('../scripts/jobs/score-job.mjs');
  const calls = [];
  await runCodexExec({ prompt: 'x', schemaPath: '/s', cwd: '/tmp', binary: '/c', spawnProcess: fakeSpawn(jsonlOk({ ok: true }), 0, calls) });
  await runCodexExec({ prompt: 'x', schemaPath: '/s', cwd: '/tmp', binary: '/c', liveSearch: true, spawnProcess: fakeSpawn(jsonlOk({ ok: true }), 0, calls) });
  const [lean, browsing] = calls;
  assert.ok(lean.includes(`model_instructions_file=${JSON.stringify(LEAN_INSTRUCTIONS_PATH)}`));
  for (const feature of ['apps', 'browser_use', 'computer_use', 'plugins', 'shell_tool', 'multi_agent']) {
    assert.ok(lean.join(' ').includes(`--disable ${feature}`), feature);
  }
  assert.equal(lean.at(-1), '-', 'the prompt is still read from stdin last');
  assert.ok(fs.existsSync(LEAN_INSTRUCTIONS_PATH));
  assert.ok(!browsing.some((arg) => arg.startsWith('model_instructions_file')));
  assert.ok(!browsing.includes('--disable'));
  assert.ok(browsing.includes('--search'));
});

test('resume analysis waits for a worthwhile batch or for the oldest job to wait long enough', async () => {
  const { analyzeSuitableResumeGaps } = await import('../scripts/jobs.mjs');
  const now = 100 * 3_600_000;
  let calls = 0;
  const analyzer = {
    version: 'v', async analyzeBatchSettled(jobs, { onProgress }) {
      calls += 1;
      onProgress?.({ completed: jobs.length, total: jobs.length, failed: 0, results: [], failures: [] });
      return { results: [], failures: [] };
    },
  };
  const context = { resumeAvailable: true, profileHash: 'p', resumeHash: 'r', profile: '', currentResume: '' };
  const storeWith = (ages) => ({
    listResumeGapCandidates: () => ages.map((hours, index) => ({ jobKey: `j${index}`, profileHash: 'p', contentHash: `c${index}`, evaluatedAt: now - hours * 3_600_000 })),
  });
  const run = (ages, config = {}) => analyzeSuitableResumeGaps({ config, store: storeWith(ages), analyzer, candidateContext: context, now });

  assert.equal((await run([1, 2])).status, 'deferred');
  assert.equal(calls, 0);
  await run([1, 2, 3, 4, 5]);
  assert.equal(calls, 1, 'five waiting jobs fill a batch');
  await run([13]);
  assert.equal(calls, 2, 'one job that waited 13h is analyzed');
  await run([1], { resumeGap: { minBatch: 1 } });
  assert.equal(calls, 3);
});

test('the WhatsApp title prefilter reads the positive list and always_allow from portals.yml', async () => {
  const { buildTitleFilter, loadTitleFilterPositive } = await import('../scripts/scan.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-portals-'));
  const file = path.join(dir, 'portals.yml');
  fs.writeFileSync(file, 'title_filter:\n  positive: ["Backend", "Data Engineer"]\n  negative: ["Junior"]\n  always_allow: ["Platform"]\n');
  const loaded = loadTitleFilterPositive(file);
  assert.deepEqual(loaded, { positive: ['Backend', 'Data Engineer'], always_allow: ['Platform'] });
  const passes = buildTitleFilter({ ...loaded, negative: [] });
  assert.equal(passes('Senior Backend Engineer at Acme · Tel Aviv'), true);
  assert.equal(passes('Platform Team Lead'), true);
  assert.equal(passes('Marketing Manager at Acme'), false);
  assert.deepEqual(loadTitleFilterPositive(path.join(dir, 'missing.yml')), { positive: [], always_allow: [] });
});
