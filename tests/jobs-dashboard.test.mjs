import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildActionCommand, parseDashboardOptions } from '../scripts/jobs/dashboard.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { createDashboardServer } from '../scripts/web.mjs';

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
  assert.throws(() => buildActionCommand('delete-everything', {}, '/project'), /Unknown action/);
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
