import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { createFailureCollector, createRunLifecycle, describeFailure, observedRun, safeTargetUrl } from '../scripts/jobs/diagnostics.mjs';
import { createDashboardServer, runCommand } from '../scripts/web.mjs';
import { completionStatusFor, evaluateCandidates } from '../scripts/jobs.mjs';
import { scanWhatsApp } from '../scripts/jobs/sources/whatsapp.mjs';

function temporary(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-diagnostics-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'jobs.db');
}

test('diagnostics classify errors without saving secrets, raw stacks or URL parameters', () => {
  for (const [message, code] of [['EPERM token=secret-value', 'permission_denied'], ['HTTP 403 secret-value', 'http_error'],
    ['ETIMEDOUT secret-value', 'timeout'], ['HTTP 429 secret-value', 'rate_limited'], ['ENOENT secret-value', 'unknown_failure'],
    ["ERROR: You've hit your usage limit. Upgrade to Pro, purchase more credits or try again at 12:29 PM.", 'codex_usage_limit']]) {
    const error = new Error(message);
    error.stack = 'at /private/project/scripts/jobs.mjs:12:4\nsecret-value';
    const diagnostic = describeFailure(error);
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.location, 'scripts/jobs.mjs:12:4');
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret-value|\/private/);
  }
  assert.equal(safeTargetUrl('https://user:password@example.com/jobs/1?token=secret-value'), 'example.com');
  assert.equal(safeTargetUrl('file:///private/secret-value'), null);
});

test('output collection handles chunk boundaries, separate streams and oversized private output', () => {
  const failures = [];
  const collector = createFailureCollector((failure) => failures.push(failure));
  collector.push('privateKey: <Buffer aa bb>\nQR private-qr\nEP', 'stderr');
  collector.push('private-body\n', 'stdout');
  collector.push('ERM private-token\n', 'stderr');
  collector.push('x'.repeat(100_000));
  collector.push('\nHTTP 403 private-token');
  collector.flush();
  assert.deepEqual(failures.map((item) => item.code), ['permission_denied', 'http_error']);
  assert.doesNotMatch(JSON.stringify(failures), /private|aa bb|xxxxx/);
});

test('legacy or stale runs are not falsely reported as running, failed or successful', () => {
  const base = { status: 'running', owner_pid: 123, heartbeat_at: 1_000 };
  assert.equal(observedRun(base, { probe: () => 'alive', now: 2_000 }).status, 'running');
  assert.equal(observedRun(base, { probe: () => 'unknown', now: 2_000 }).status, 'running');
  assert.equal(observedRun(base, { probe: () => 'alive', now: 100_000 }).diagnostic.code, 'heartbeat_stale');
  assert.equal(observedRun(base, { probe: () => 'dead' }).diagnostic.code, 'process_missing');
  assert.equal(observedRun({ ...base, owner_pid: null }).diagnostic.code, 'legacy_unknown');
  assert.equal(base.status, 'running');
});

test('stage and completed source survive failure, migration and reopening the database', (context) => {
  const db = temporary(context);
  let store = createJobStore(db);
  const id = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats', 'whatsapp'], ownerPid: process.pid });
  const lifecycle = createRunLifecycle(store, id);
  store.touchRun(id, { details: { ats: { found: 19 } } });
  lifecycle.stage('whatsapp-connect', 'whatsapp');
  lifecycle.finish('failed', { failure: describeFailure(new Error('EPERM private-token')) });
  lifecycle.dispose();
  store.close();
  store = createJobStore(db);
  context.after(() => store.close());
  const run = store.getRun(id);
  assert.equal(run.stage, 'whatsapp-connect');
  assert.equal(run.details.ats.found, 19);
  assert.equal(run.diagnostic.code, 'permission_denied');
  assert.equal(run.events.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(run), /private-token/);
});

for (const mode of ['SIGTERM', 'SIGKILL', 'uncaught']) {
  test(`real child process ${mode} retains interruption evidence and completed ATS data`, { timeout: 10_000 }, async (context) => {
    const db = temporary(context);
    const child = fork(new URL('./fixtures/diagnostic-child.mjs', import.meta.url), [db], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    context.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
    const exit = once(child, 'exit');
    const [{ id }] = await once(child, 'message');
    if (mode === 'uncaught') child.send('crash'); else child.kill(mode);
    await exit;
    const store = createJobStore(db);
    context.after(() => store.close());
    const run = store.getRun(id);
    assert.equal(run.details.ats.found, 42);
    assert.equal(run.stage, 'whatsapp-connect');
    assert.equal(run.status, mode === 'uncaught' ? 'failed' : 'interrupted');
    assert.equal(run.diagnostic.code, mode === 'SIGKILL' ? 'process_missing' : mode === 'SIGTERM' ? 'process_interrupted' : 'permission_denied');
    assert.doesNotMatch(JSON.stringify(run), /private-body/);
  });
}

test('detail history always includes the final failure after more than 500 events', (context) => {
  const store = createJobStore(temporary(context));
  context.after(() => store.close());
  const id = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats'] });
  for (let index = 0; index < 510; index += 1) store.recordRunEvent(id, { source: 'ats', scope: 'source', stage: 'collection', status: 'started' });
  store.recordRunEvent(id, { source: 'ats', scope: 'source', stage: 'collection', status: 'failed', details: describeFailure(new Error('timeout')) });
  store.finishRun(id, { status: 'failed' });
  const run = store.getRun(id);
  assert.equal(run.events.length, 500);
  assert.equal(run.events.at(-1).status, 'failed');
  assert.equal(run.eventCount, 511);
});

test('evaluateCandidates reports page-content length distribution ahead of scoring', async (context) => {
  const store = createJobStore(temporary(context));
  context.after(() => store.close());
  const lengths = [100, 5_000, 9_000]; // one over the 8,000-char pageText cap
  const candidates = lengths.map((length, index) => ({
    ...store.recordSighting({ url: `https://example.com/jobs/${index}`, source: 'ATS: Example' }),
    url: `https://example.com/jobs/${index}`,
  }));
  const pages = new Map(candidates.map((candidate, index) => [candidate.url, 'x'.repeat(lengths[index])]));
  let stats = null;
  await evaluateCandidates({
    candidates, config: { decision: { criteriaVersion: 'v1' } }, store,
    fetcher: { fetch: async (url) => ({ status: 'active', finalUrl: url, content: pages.get(url), contentHash: url }) },
    scorer: { profileHash: 'p', scoreBatchSettled: async () => {} },
    onContentStats: (value) => { stats = value; },
  });

  assert.equal(stats.count, 3);
  assert.equal(stats.minChars, 100);
  assert.equal(stats.maxChars, 9_000);
  assert.equal(stats.avgChars, Math.round((100 + 5_000 + 9_000) / 3));
  assert.equal(stats.medianChars, 5_000);
  assert.equal(stats.capChars, 8_000);
  assert.equal(stats.atOrOverCapCount, 1);
});

test('a WhatsApp link with a negative-keyword title is filtered locally, never reaching the scorer — an ATS link with the same text is not', async (context) => {
  const store = createJobStore(temporary(context));
  context.after(() => store.close());
  const whatsappCandidate = {
    ...store.recordSighting({ url: 'https://example.com/jobs/1', source: 'WhatsApp: Group A' }),
    url: 'https://example.com/jobs/1', source: 'WhatsApp: Group A',
  };
  const atsCandidate = {
    ...store.recordSighting({ url: 'https://example.com/jobs/2', source: 'ATS: greenhouse-api' }),
    url: 'https://example.com/jobs/2', source: 'ATS: greenhouse-api',
  };
  let scoreCalls = 0;

  const outcomes = await evaluateCandidates({
    candidates: [whatsappCandidate, atsCandidate], store,
    config: { decision: { criteriaVersion: 'v1' }, rootDir: process.cwd() },
    fetcher: { fetch: async (url) => ({ status: 'active', finalUrl: url, content: 'Junior Backend Engineer, apply now.', contentHash: url }) },
    scorer: {
      profileHash: 'p',
      scoreBatchSettled: async (items, { onProgress }) => {
        scoreCalls += items.length;
        onProgress({ completed: items.length, total: items.length, failed: 0, results: [], failures: [] });
      },
    },
  });

  assert.equal(scoreCalls, 1, 'only the ATS candidate should reach the scorer');
  assert.equal(outcomes.get(whatsappCandidate.jobKey).status, 'not-suitable');
  const filtered = store.getJob(whatsappCandidate.jobKey);
  assert.equal(filtered.suitable, 0);
  assert.equal(filtered.evaluated_at != null, true, 'must be recorded as resolved, not left pending for retry');
});

test('a scoring failure is stored with its specific reason, while a page-fetch failure keeps its own specific code', async (context) => {
  const store = createJobStore(temporary(context));
  context.after(() => store.close());
  const scoringCandidate = { ...store.recordSighting({ url: 'https://example.com/jobs/scored', source: 'ATS: Example' }), url: 'https://example.com/jobs/scored' };
  const blockedCandidate = { ...store.recordSighting({ url: 'https://example.com/jobs/blocked', source: 'ATS: Example' }), url: 'https://example.com/jobs/blocked' };

  await evaluateCandidates({
    candidates: [scoringCandidate, blockedCandidate], config: { decision: { criteriaVersion: 'v1' } }, store,
    fetcher: {
      fetch: async (url) => url.endsWith('/blocked')
        ? { status: 'uncertain', code: 'access_blocked', reason: 'HTTP 403 (access blocked, likely anti-bot)', contentHash: 'h' }
        : { status: 'active', finalUrl: url, content: 'Backend role.', contentHash: 'h' },
    },
    scorer: {
      profileHash: 'p',
      scoreBatchSettled: async (items, { onProgress }) => {
        onProgress({
          completed: 1, total: 1, failed: 1, results: [],
          failures: [{ jobKey: items[0].candidate.jobKey, code: 'scoring_failed', reason: "ERROR: You've hit your usage limit. purchase more credits" }],
        });
      },
    },
  });

  // scoring_failed only ever meant "something went wrong in a batch call" —
  // describeFailure's own classification is strictly more specific and is
  // now what gets persisted, so a repeat failure is diagnosable without
  // guessing or re-running a live probe.
  assert.equal(store.getJob(scoringCandidate.jobKey).last_error_code, 'codex_usage_limit');
  // access_blocked is already specific; describeFailure's generic
  // HTTP-status fallback ("http_error") would only make it coarser, so it
  // must be left untouched.
  assert.equal(store.getJob(blockedCandidate.jobKey).last_error_code, 'access_blocked');
});

test('failed evaluation keeps retry identity and reports the actual processing stage', async (context) => {
  const store = createJobStore(temporary(context));
  context.after(() => store.close());
  const candidate = { ...store.recordSighting({ url: 'https://example.com/jobs/1', source: 'WhatsApp: Group A' }), url: 'https://example.com/jobs/1' };
  const failures = [];
  await evaluateCandidates({ candidates: [candidate], config: { decision: { criteriaVersion: 'v1' } }, store,
    fetcher: { fetch: async () => { throw new Error('HTTP 403 private-content'); } },
    scorer: { profileHash: 'p', scoreBatchSettled: async () => {} },
    onFailure: (item, failure, stage) => failures.push({ item, failure, stage }),
  });
  assert.equal(failures[0].stage, 'page-fetch');
  assert.equal(failures[0].failure.httpStatus, 403);
  assert.equal(store.listPendingEvaluation().length, 1);
  assert.doesNotMatch(store.getJob(candidate.jobKey).last_error_reason, /private-content/);
  assert.equal(completionStatusFor({ ats: { errors: 1 } }), 'incomplete');
  assert.equal(completionStatusFor({ whatsapp: { coverageStatus: 'complete', groups: [{ failedMessages: 1 }] } }), 'incomplete');
});

test('missing WhatsApp groups get a named failure before the source aborts', async () => {
  const events = [];
  const stages = [];
  const config = { sources: { whatsapp: { enabled: true, authAbsPath: '/unused', groups: [{ jid: 'private@g.us', name: 'Group A' }] } } };
  await assert.rejects(scanWhatsApp({ config, store: {}, sinceMs: 1,
    connect: async () => ({ groupFetchAllParticipating: async () => ({}) }), disconnect: async () => {},
    onDiagnostic: (event) => events.push(event), onStage: (stage) => stages.push(stage),
  }), /unavailable/);
  assert.deepEqual(stages, ['whatsapp-connect', 'verify-groups']);
  assert.equal(events[0].scopeKey, 'Group A');
  assert.equal(events[0].details.code, 'group_unavailable');
  assert.doesNotMatch(JSON.stringify(events), /private@g.us/);
});

test('API retains failed actions after a successful action and a server restart without raw output', async (context) => {
  const db = temporary(context);
  const config = { rootDir: path.dirname(db), jobsDbPath: db, scan: { defaultLookbackDays: 2, maxLookbackDays: 14 }, sources: { whatsapp: { groups: [] } } };
  let attempt = 0;
  const execute = async (command, root, output, { actionId }) => {
    attempt += 1;
    if (attempt !== 1) return;
    const store = createJobStore(db);
    const id = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats'], actionId });
    store.finishRun(id, { status: 'failed', failure: describeFailure(new Error('EPERM')) });
    store.close();
    output('EP', 'stderr'); output('ERM private-raw-body\nprivateKey: <Buffer aa bb>\nQR private-qr', 'stderr');
    throw Object.assign(new Error('private-exception'), { exitCode: 2 });
  };
  const readiness = { inspect: async () => ({
    browser: { status: 'ready' }, scorer: { status: 'ready' }, collector: { status: 'ready' },
    readyFor: { ats: true, whatsapp: true },
  }) };
  let server = createDashboardServer({ config, execute, readiness });
  const listen = async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
  let base = await listen();
  context.after(() => server.close());
  const first = await fetch(`${base}/api/actions/scan`, { method: 'POST', body: JSON.stringify({ days: 2, source: 'ats' }) }).then((r) => r.json());
  await new Promise((resolve) => setImmediate(resolve));
  await fetch(`${base}/api/actions/mark-read`, { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => server.close(resolve));
  server = createDashboardServer({ config, execute, readiness });
  base = await listen();
  const { detail } = await fetch(`${base}/api/diagnostics/actions/${first.action.id}`).then((r) => r.json());
  assert.equal(detail.status, 'error');
  assert.equal(detail.diagnostic.exitCode, 2);
  assert.equal(detail.warnings[0].code, 'permission_denied');
  assert.equal(detail.runIds.length, 1);
  assert.doesNotMatch(JSON.stringify(detail), /private-|aa bb/);
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state.history.filter((item) => item.kind === 'actions').length, 2);
  const collectorStore = createJobStore(db);
  const collectorId = Number(collectorStore.startCollectorRun({ ownerPid: process.pid, groupsExpected: 4 }));
  collectorStore.finishCollectorRun(collectorId, { status: 'stopped' });
  collectorStore.close();
  const collectorDetail = await fetch(`${base}/api/diagnostics/collectors/${collectorId}`).then((r) => r.json());
  assert.equal(collectorDetail.detail.status, 'stopped');
  for (const suffix of ['runs/99999', 'runs/-1', 'runs/1%27OR1=1', 'runs/9999999999999999', 'actions/nope']) {
    assert.equal((await fetch(`${base}/api/diagnostics/${suffix}`)).status, 404);
  }
});

test('subprocess termination records signal and drains final stderr', async () => {
  const output = [];
  await assert.rejects(runCommand({ command: process.execPath, args: ['-e', "process.stderr.write('HTTP 403\\n'); process.exitCode = 3;"] }, process.cwd(), (chunk) => output.push(chunk)),
    (error) => error.exitCode === 3 && !error.signal);
  assert.match(output.join(''), /HTTP 403/);
  await assert.rejects(runCommand({ command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGTERM');"] }, process.cwd(), () => {}),
    (error) => error.signal === 'SIGTERM');
});

test('a failing diagnostic output callback rejects the command instead of crashing the server', { timeout: 5_000 }, async () => {
  await assert.rejects(runCommand({ command: process.execPath,
    args: ['-e', "console.log('progress'); setInterval(() => {}, 1000);"] }, process.cwd(),
  () => { throw Object.assign(new Error('database is full'), { code: 'SQLITE_FULL' }); }), /database is full/);
});
