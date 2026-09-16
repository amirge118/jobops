import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildActionCommand, parseBacklogOptions, parseDashboardOptions } from '../scripts/jobs/dashboard.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { createDashboardServer, sanitizeCommandOutput } from '../scripts/web.mjs';

const readyState = {
  checkedAt: 1,
  browser: { status: 'ready', code: null },
  scorer: { status: 'ready', code: null },
  collector: { status: 'ready', code: null },
  readyFor: { ats: true, whatsapp: true },
};
const readyService = { inspect: async () => readyState };

test('dashboard scan options become a shell-free jobs command', () => {
  const options = parseDashboardOptions({ days: 2, source: 'whatsapp', open: true }, 14);
  assert.deepEqual(options, { days: 2, source: 'whatsapp', open: true });
  assert.deepEqual(buildActionCommand('scan', options, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs.mjs', '--days', '2', '--whatsapp-only', '--open'],
  });
});

test('dashboard accepts only bounded days and known sources', () => {
  assert.throws(() => parseDashboardOptions({ days: 0, source: 'all' }, 14), /days/);
  assert.throws(() => parseDashboardOptions({ days: 15, source: 'all' }, 14), /days/);
  assert.throws(() => parseDashboardOptions({ days: 2, source: 'shell' }, 14), /source/);
});

test('dashboard actions use fixed scripts and reject unknown actions', () => {
  assert.deepEqual(buildActionCommand('verify-groups', {}, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs/verify-groups.mjs'],
  });
  assert.deepEqual(buildActionCommand('open-jobs', {}, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs/open.mjs'],
  });
  assert.deepEqual(buildActionCommand('retry-failed', {}, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs.mjs', '--retry-only'],
  });
  assert.deepEqual(buildActionCommand('mark-read', {}, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs/mark-groups-read.mjs'],
  });
  assert.deepEqual(parseBacklogOptions({ days: 7 }), { days: 7 });
  assert.deepEqual(parseBacklogOptions({ days: null }), { days: null });
  assert.deepEqual(buildActionCommand('process-backlog', { days: 7 }, '/project'), {
    command: process.execPath,
    args: ['/project/scripts/jobs.mjs', '--whatsapp-backlog', '--days', '7'],
  });
  assert.throws(() => buildActionCommand('delete-everything', {}, '/project'), /Unknown action/);
});

test('dashboard exposes WhatsApp backlog and queues one durable history request', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-history-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'group-a@g.us' }] } },
  };
  const store = createJobStore(config.jobsDbPath);
  store.queueWhatsAppMessage({ messageId: 'pending-1', groupJid: 'group-a@g.us', timestamp: Date.now(), text: 'https://example.com/job' });
  store.markWhatsAppMessagesRead([{ id: 'pending-1', remoteJid: 'group-a@g.us' }], { readAt: Date.now() });
  const collectorId = store.startCollectorRun({ ownerPid: process.pid, groupsExpected: 1 });
  store.updateCollectorRun(collectorId, { status: 'connected', stage: 'connected', connectedAt: Date.now(), groupsFound: 1 });
  const missingFrom = Date.now() - 24 * 60 * 60 * 1_000;
  const missing = store.requestWhatsAppHistory({
    fromTs: missingFrom, toTs: Date.now(), groupsTotal: 1,
    groups: [{ name: 'Group A', requestedFrom: missingFrom }],
  });
  store.claimNextWhatsAppHistoryRequest({ ownerPid: process.pid });
  store.recordWhatsAppHistoryGroup(missing.request.id, {
    name: 'Group A', status: 'failed', requestedFrom: missingFrom,
    reason: 'history_no_response',
  });
  store.finishWhatsAppHistoryRequest(missing.request.id, { status: 'failed' });
  store.close();
  const server = createDashboardServer({ config, readiness: readyService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const scan = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  assert.equal(scan.whatsappHistory.backlog.total, 1);
  assert.equal(scan.whatsappHistory.backlog.groups[0].name, 'Group A');
  assert.equal(Object.hasOwn(scan.whatsappHistory.backlog.groups[0], 'groupJid'), false);
  assert.ok(scan.whatsappHistory.backlog.groups[0].lastCollectedAt);
  assert.ok(scan.whatsappHistory.backlog.groups[0].lastReadAt);
  assert.equal(scan.whatsappHistory.backlog.groups[0].syncState, 'live-with-gap');
  assert.equal(scan.whatsappHistory.backlog.groups[0].gapFrom, missingFrom);

  const queuedResponse = await fetch(`${baseUrl}/api/whatsapp/history`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30 }),
  });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.equal(queued.created, true);
  assert.equal(queued.request.status, 'pending');
  assert.equal(queued.request.groups[0].name, 'Group A');
  assert.equal(queued.request.groups[0].requestedFrom, scan.whatsappHistory.backlog.groups[0].lastCollectedAt - 1_000);

  const duplicateResponse = await fetch(`${baseUrl}/api/whatsapp/history`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30 }),
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).created, false);

  const simpleCrossOriginShape = await fetch(`${baseUrl}/api/whatsapp/history`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ days: 30 }),
  });
  assert.equal(simpleCrossOriginShape.status, 415);
});

test('dashboard exposes rolling 36h/7d group stats and ATS-vs-WhatsApp source performance', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-insights-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const store = createJobStore(config.jobsDbPath);
  const now = Date.now();
  const seedRun = (finishedAt, details) => {
    const runId = store.startRun({ fromTs: finishedAt - 1_000, toTs: finishedAt, sources: ['ats', 'whatsapp'], startedAt: finishedAt - 1_000 });
    store.finishRun(runId, { status: 'success', details, finishedAt });
  };
  // Inside both windows.
  seedRun(now - 60 * 60 * 1_000, {
    whatsapp: { groups: [{ name: 'Group A', coverage: { delivered: 5 } }] },
    processing: { scopes: [
      { source: 'whatsapp', name: 'Group A', processed: 2, suitable: 1, notSuitable: 1, filtered: 2, failed: 0 },
      { source: 'ats', name: 'ATS', processed: 4, suitable: 1, notSuitable: 3, filtered: 0, failed: 0 },
    ] },
  });
  // Inside the 7-day window only.
  seedRun(now - 3 * 24 * 60 * 60 * 1_000, {
    whatsapp: { groups: [{ name: 'Group A', coverage: { delivered: 3 } }] },
    processing: { scopes: [{ source: 'whatsapp', name: 'Group A', processed: 1, suitable: 0, notSuitable: 1, filtered: 0, failed: 0 }] },
  });
  // Older than both windows — must not be counted anywhere.
  seedRun(now - 10 * 24 * 60 * 60 * 1_000, {
    whatsapp: { groups: [{ name: 'Group A', coverage: { delivered: 100 } }] },
    processing: { scopes: [{ source: 'whatsapp', name: 'Group A', processed: 100, suitable: 100, notSuitable: 0, filtered: 0, failed: 0 }] },
  });
  store.close();
  const server = createDashboardServer({ config, readiness: readyService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const scan = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  const short = scan.insights.windows['36h'];
  assert.equal(short.runsCounted, 1);
  assert.deepEqual(short.groups, [{ name: 'Group A', received: 5, processed: 2, suitable: 1, notSuitable: 1, filtered: 2, failed: 0, runs: 1 }]);
  assert.equal(short.sourcePerformance.ats.costPerSuitable, 4);
  assert.equal(short.sourcePerformance.whatsapp.costPerSuitable, 2);

  const week = scan.insights.windows['7d'];
  assert.equal(week.runsCounted, 2);
  assert.deepEqual(week.groups, [{ name: 'Group A', received: 8, processed: 3, suitable: 1, notSuitable: 2, filtered: 2, failed: 0, runs: 2 }]);
});

test('dashboard command output redacts cryptographic buffers and session identifiers', () => {
  const output = sanitizeCommandOutput(
    "Closing session: { privateKey: <Buffer aa bb cc>, 'AbCdEfGhIjKlMnOpQrStUv==': { chainKey: {} } }",
  );

  assert.equal(output.includes('aa bb cc'), false);
  assert.equal(output.includes('AbCdEfGhIjKlMnOpQrStUv'), false);
  assert.match(output, /redacted-buffer/);
  assert.match(output, /redacted-session/);
});

test('dashboard API exposes state and prevents overlapping actions', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let finishAction;
  const actionPromise = new Promise((resolve) => { finishAction = resolve; });
  const commands = [];
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    sources: { whatsapp: { groups: [{ name: 'Group A' }] } },
  };
  const server = createDashboardServer({
    config,
    readiness: readyService,
    execute(command, rootDir, onOutput) {
      commands.push({ command, rootDir });
      onOutput('started');
      return actionPromise;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(initial.action.status, 'idle');
  assert.equal(initial.settings.groups.length, 1);

  const startedResponse = await fetch(`${baseUrl}/api/actions/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 2, source: 'ats', open: false }),
  });
  assert.equal(startedResponse.status, 202);
  assert.deepEqual(commands[0].command.args, [
    path.join(tempDir, 'scripts', 'jobs.mjs'), '--days', '2', '--ats-only',
  ]);

  const overlapResponse = await fetch(`${baseUrl}/api/actions/open-jobs`, { method: 'POST' });
  assert.equal(overlapResponse.status, 409);

  finishAction();
  await new Promise((resolve) => setImmediate(resolve));
  const finished = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(finished.action.status, 'success');
  assert.equal(finished.action.output, 'started');
});

test('dashboard API archives one known job and rejects unknown job keys', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-archive-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const store = createJobStore(config.jobsDbPath);
  const sighting = store.recordSighting({
    url: 'https://example.com/jobs/42',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'ats',
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Backend systems.',
    score: 4.5, fitLabel: 'בול מתאים', decisionReason: 'Strong match.', suitable: true,
    applyUrl: sighting.canonicalUrl, activeStatus: 'active', contentHash: 'v1',
    profileHash: 'profile-v1', criteriaVersion: 'v1', evaluatedAt: Date.now(),
  });
  store.close();

  const server = createDashboardServer({ config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const archivedResponse = await fetch(`${baseUrl}/api/jobs/${sighting.jobKey}/archive`, { method: 'POST' });
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.archived, true);
  assert.equal(archived.state.jobs.length, 0);

  const missingResponse = await fetch(`${baseUrl}/api/jobs/aaaaaaaaaaaaaaaaaaaaaaaa/archive`, { method: 'POST' });
  assert.equal(missingResponse.status, 404);
});

test('dashboard reports a failure breakdown with retryable flags and can bulk-archive the unretryable ones', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-failures-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const store = createJobStore(config.jobsDbPath);
  const blocked = store.recordSighting({ url: 'https://example.com/jobs/blocked', source: 'ats' });
  const timedOut = store.recordSighting({ url: 'https://example.com/jobs/timeout', source: 'ats' });
  store.markEvaluationFailure(blocked.jobKey, { code: 'bot_challenge', reason: 'Anti-bot wall.' });
  store.markEvaluationFailure(timedOut.jobKey, { code: 'timeout', reason: 'Slow host.' });
  store.close();

  const server = createDashboardServer({ config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const scan = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  assert.deepEqual(scan.failures.breakdown, [
    { code: 'bot_challenge', count: 1, retryable: false },
    { code: 'timeout', count: 1, retryable: true },
  ]);
  assert.equal(scan.failures.retryableTotal, 1);
  assert.equal(scan.failures.nonRetryableTotal, 1);

  const archivedResponse = await fetch(`${baseUrl}/api/jobs/archive-failed`, { method: 'POST' });
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.archived, 1);

  const after = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  assert.deepEqual(after.failures.breakdown, [{ code: 'timeout', count: 1, retryable: true }]);
  assert.equal(after.failures.nonRetryableTotal, 0);
});

test('dashboard serves three real pages and focused page APIs', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-pages-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const config = {
    rootDir: projectRoot,
    jobsDbPath: path.join(tempDir, 'jobs.db'),
    demo: true,
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [{ name: 'Group A' }] } },
  };
  const server = createDashboardServer({ config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const root = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/scan');

  for (const [route, marker] of [
    ['/scan', 'data-page="scan"'],
    ['/decisions', 'data-page="decisions"'],
    ['/companies', 'data-page="companies"'],
  ]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(marker));
  }

  const summary = await fetch(`${baseUrl}/api/summary`).then((response) => response.json());
  assert.deepEqual(summary.jobs, { suitable: 0, unopened: 0 });
  assert.equal(summary.groups, 1);

  const scan = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  assert.equal(scan.settings.maxLookbackDays, 14);
  assert.equal(scan.action.status, 'idle');
  assert.equal(scan.readiness.readyFor.ats, true);
  assert.equal(scan.diagnosis.status, 'empty');
  assert.equal(Object.hasOwn(scan, 'jobs'), false);

  const jobs = await fetch(`${baseUrl}/api/jobs`).then((response) => response.json());
  assert.deepEqual(jobs.jobs, []);
  assert.equal(Object.hasOwn(jobs, 'history'), false);

  const history = await fetch(`${baseUrl}/api/diagnostics/history`).then((response) => response.json());
  assert.deepEqual(history.history, []);
});

test('dashboard blocks an impossible scan and returns an actionable readiness result', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-readiness-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let executed = false;
  const blockedState = {
    ...readyState,
    browser: { status: 'blocked', code: 'sandboxed_runtime', reason: 'blocked', nextStep: 'open externally' },
    scorer: { status: 'blocked', code: 'sandboxed_runtime', reason: 'blocked', nextStep: 'open externally' },
    readyFor: { ats: false, whatsapp: false },
  };
  const config = {
    rootDir: tempDir,
    jobsDbPath: path.join(tempDir, 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const server = createDashboardServer({
    config,
    readiness: { inspect: async () => blockedState },
    execute: async () => { executed = true; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/actions/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 1, source: 'ats', open: false }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, 'scan_not_ready');
  assert.deepEqual(payload.blockers.map((blocker) => blocker.code), ['sandboxed_runtime']);
  assert.equal(executed, false);

  const backlogResponse = await fetch(`${baseUrl}/api/actions/process-backlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 7 }),
  });
  const backlogPayload = await backlogResponse.json();

  assert.equal(backlogResponse.status, 409);
  assert.equal(backlogPayload.code, 'scan_not_ready');
  assert.deepEqual(backlogPayload.blockers.map((blocker) => blocker.code), ['sandboxed_runtime']);
  assert.equal(executed, false);
});

test('polling APIs keep detailed event timelines behind the diagnostic detail route', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dashboard-payload-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const config = {
    rootDir: projectRoot,
    jobsDbPath: path.join(tempDir, 'jobs.db'),
    demo: true,
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const store = createJobStore(config.jobsDbPath);
  const runId = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats'] });
  store.recordRunEvent(runId, { source: 'ats', scope: 'source', stage: 'collection', status: 'complete', count: 1 });
  store.finishRun(runId, { status: 'success', details: { ats: { found: 1, candidates: 1, errors: 0 } } });
  store.close();

  const server = createDashboardServer({ config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const scan = await fetch(`${baseUrl}/api/scan`).then((response) => response.json());
  assert.equal(scan.lastRun.id, Number(runId));
  assert.equal(Object.hasOwn(scan.lastRun, 'events'), false);

  const history = await fetch(`${baseUrl}/api/diagnostics/history`).then((response) => response.json());
  assert.equal(Object.hasOwn(history.history[0], 'events'), false);

  const detail = await fetch(`${baseUrl}/api/diagnostics/runs/${runId}`).then((response) => response.json());
  assert.equal(detail.detail.events.length, 1);
});
