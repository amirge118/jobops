import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isJobOpsDashboardProcess,
  parseListeningPids,
  stopDashboard,
} from '../scripts/local-dashboard-process.mjs';

test('local dashboard PID parsing is bounded and deduplicated', () => {
  assert.deepEqual(parseListeningPids('123\n456\n123\nnot-a-pid\n'), [123, 456]);
  assert.deepEqual(parseListeningPids(''), []);
});

test('stop command recognizes only a jobOps dashboard from the same project', () => {
  const rootDir = '/projects/jobOps';
  assert.equal(isJobOpsDashboardProcess({
    cwd: rootDir,
    command: '/usr/local/bin/node scripts/web.mjs --open',
  }, rootDir), true);
  assert.equal(isJobOpsDashboardProcess({
    cwd: rootDir,
    command: '/usr/local/bin/node scripts/start-local.mjs',
  }, rootDir), true);
  assert.equal(isJobOpsDashboardProcess({
    cwd: '/projects/another-app',
    command: '/usr/local/bin/node scripts/web.mjs',
  }, rootDir), false);
  assert.equal(isJobOpsDashboardProcess({
    cwd: rootDir,
    command: '/usr/local/bin/node server.mjs',
  }, rootDir), false);
});

test('stop command sends TERM only to a verified dashboard', async () => {
  const signals = [];
  const result = await stopDashboard({
    rootDir: '/projects/jobOps',
    findPids: () => [123],
    inspectProcess: () => ({
      cwd: '/projects/jobOps',
      command: '/usr/local/bin/node scripts/start-local.mjs',
    }),
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    waitUntilStopped: async () => true,
  });

  assert.deepEqual(signals, [[123, 'SIGTERM']]);
  assert.deepEqual(result, { status: 'stopped', pids: [123], forced: [] });
});

test('stop command refuses to terminate an unrelated listener', async () => {
  const signals = [];
  await assert.rejects(
    stopDashboard({
      rootDir: '/projects/jobOps',
      findPids: () => [999],
      inspectProcess: () => ({
        cwd: '/projects/other',
        command: '/usr/local/bin/node scripts/web.mjs',
      }),
      sendSignal: (...args) => signals.push(args),
    }),
    /not a verified jobOps dashboard/,
  );
  assert.deepEqual(signals, []);
});

test('stop command escalates only a verified dashboard that ignores TERM', async () => {
  const signals = [];
  let waits = 0;
  const result = await stopDashboard({
    rootDir: '/projects/jobOps',
    findPids: () => [321],
    inspectProcess: () => ({
      cwd: '/projects/jobOps',
      command: '/usr/local/bin/node scripts/web.mjs',
    }),
    sendSignal: (pid, signal) => signals.push([pid, signal]),
    waitUntilStopped: async () => {
      waits += 1;
      return waits > 1;
    },
  });

  assert.deepEqual(signals, [[321, 'SIGTERM'], [321, 'SIGKILL']]);
  assert.deepEqual(result, { status: 'stopped', pids: [321], forced: [321] });
});
