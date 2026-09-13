import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockersForAction,
  inspectRuntimeReadiness,
} from '../scripts/dashboard/readiness.mjs';
import { assertExternalRuntime, collectorNeedsRestart } from '../scripts/start-local.mjs';

test('local launcher refuses a Codex sandbox and accepts a normal terminal', () => {
  assert.throws(
    () => assertExternalRuntime({ CODEX_SANDBOX: 'seatbelt' }),
    /macOS Terminal app/,
  );
  assert.doesNotThrow(() => assertExternalRuntime({}));
});

test('local launcher restarts a missing or unhealthy Collector but preserves a connected one', () => {
  assert.equal(collectorNeedsRestart({ serviceLoaded: false, collector: { status: 'connected' } }), true);
  assert.equal(collectorNeedsRestart({ serviceLoaded: true, collector: null }), true);
  assert.equal(collectorNeedsRestart({ serviceLoaded: true, collector: { status: 'reconnecting' } }), true);
  assert.equal(collectorNeedsRestart({ serviceLoaded: true, collector: { status: 'unconfirmed' } }), true);
  assert.equal(collectorNeedsRestart({ serviceLoaded: true, collector: { status: 'connected' } }), false);
});

test('sandboxed dashboard reports browser and scorer blockers without launching Chromium', async () => {
  let browserProbes = 0;
  const readiness = await inspectRuntimeReadiness({
    config: { demo: false },
    collector: { status: 'failed', diagnostic: { code: 'network_error' } },
    env: { CODEX_SANDBOX: 'seatbelt' },
    probeBrowser: async () => { browserProbes += 1; },
    probeCodexState: async () => {},
    now: 123,
  });

  assert.equal(browserProbes, 0);
  assert.equal(readiness.checkedAt, 123);
  assert.equal(readiness.browser.status, 'blocked');
  assert.equal(readiness.scorer.status, 'blocked');
  assert.equal(readiness.collector.status, 'blocked');
  assert.equal(readiness.readyFor.ats, false);
  assert.equal(readiness.readyFor.whatsapp, false);
  assert.deepEqual(blockersForAction(readiness, 'scan', { source: 'ats' }).map((item) => item.code), [
    'sandboxed_runtime',
  ]);
  assert.deepEqual(blockersForAction(readiness, 'process-backlog').map((item) => item.code), [
    'sandboxed_runtime',
  ]);
});

test('readiness permits ATS without Collector and requires Collector for WhatsApp', async () => {
  const readiness = await inspectRuntimeReadiness({
    config: { demo: false },
    collector: { status: 'stopped' },
    env: {},
    probeBrowser: async () => {},
    probeCodexState: async () => {},
  });

  assert.equal(readiness.readyFor.ats, true);
  assert.equal(readiness.readyFor.whatsapp, false);
  assert.equal(blockersForAction(readiness, 'scan', { source: 'ats' }).length, 0);
  assert.deepEqual(blockersForAction(readiness, 'scan', { source: 'all' }).map((item) => item.code), [
    'collector_offline',
  ]);
  assert.equal(blockersForAction(readiness, 'retry-failed').length, 0);
});

test('readiness distinguishes a signed-out scorer from filesystem failure', async () => {
  const signedOut = new Error('signed out');
  signedOut.readinessCode = 'scorer_not_logged_in';
  const readiness = await inspectRuntimeReadiness({
    config: { demo: false },
    collector: { status: 'connected' },
    env: {},
    probeBrowser: async () => {},
    probeCodexState: async () => { throw signedOut; },
  });

  assert.equal(readiness.scorer.code, 'scorer_not_logged_in');
  assert.match(readiness.scorer.nextStep, /codex login/);
  assert.equal(readiness.readyFor.ats, false);
});
