import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateHealth, runHealthCheck } from '../scripts/jobs/health-check.mjs';
import { completionStatusFor, liveCollectorSince, summarizeSourceResults } from '../scripts/jobs.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const HOUR = 60 * 60 * 1000;
// 15:00 and 03:00 in Israel (UTC+3 in October).
const AFTERNOON = Date.parse('2026-10-05T12:00:00Z');
const NIGHT = Date.parse('2026-10-05T00:00:00Z');

// A healthy baseline: every rule must stay quiet on it.
function facts(overrides = {}) {
  return {
    now: AFTERNOON,
    companyFailures: [],
    lastRuns: { ats: { finishedAt: AFTERNOON - HOUR }, linkedin: { finishedAt: AFTERNOON - 2 * HOUR }, 'whatsapp-backlog': null },
    stuckRuns: [],
    codexCalls: [{ ok: 1 }, { ok: 1 }],
    llmBlockedUntil: null,
    linkedinBlockedUntil: null,
    linkedinSearches: [{ key: 'backend', lastStatus: 'complete', lastSuccessAt: AFTERNOON - HOUR }],
    collector: { status: 'connected', started_at: AFTERNOON - 10 * HOUR, reconnects: 2 },
    oldestPendingMessageAt: null,
    failedJobs: [],
    resumeGapFailures: 0,
    ...overrides,
  };
}
const keys = (findings) => findings.map((finding) => finding.key);

test('a healthy system has no findings', () => {
  assert.deepEqual(evaluateHealth(facts()), []);
});

test('a company that failed once is not a finding; failing in three runs is', () => {
  const findings = evaluateHealth(facts({ companyFailures: [
    { company: 'Faye', runs: 1, code: 'timeout' },
    { company: 'Lumia', runs: 3, code: 'http_403' },
  ] }));
  assert.deepEqual(keys(findings), ['ats-company:Lumia']);
  assert.match(findings[0].detail, /3 ריצות.*http_403/);
});

test('a missing scheduled ATS run counts only during the hours it is scheduled', () => {
  const stale = { lastRuns: { ats: { finishedAt: AFTERNOON - 5 * HOUR }, linkedin: { finishedAt: AFTERNOON - HOUR } } };
  assert.deepEqual(keys(evaluateHealth(facts(stale))), ['stale:ats']);
  assert.deepEqual(keys(evaluateHealth(facts({ ...stale, now: NIGHT }))), []);
});

test('a run whose heartbeat stopped is stuck', () => {
  const findings = evaluateHealth(facts({ stuckRuns: [{ id: 41, stage: 'scoring', heartbeatAt: AFTERNOON - HOUR }] }));
  assert.deepEqual(keys(findings), ['stuck-run:41']);
  assert.equal(findings[0].severity, 'error');
});

test('Codex: a one-off failure is quiet; a failing streak and a block are errors with the reason', () => {
  assert.deepEqual(evaluateHealth(facts({ codexCalls: [{ ok: 1 }, { ok: 0, errorReason: 'x' }, { ok: 1 }] })), []);
  const streak = evaluateHealth(facts({ codexCalls: [
    { ok: 0, errorReason: 'stream disconnected' }, { ok: 0 }, { ok: 0 }, { ok: 1 },
  ] }));
  assert.deepEqual(keys(streak), ['codex:consecutive']);
  assert.match(streak[0].detail, /stream disconnected/);
  assert.deepEqual(keys(evaluateHealth(facts({ llmBlockedUntil: AFTERNOON + HOUR }))), ['codex:blocked']);
});

test('WhatsApp: a dead collector is an error; frequent reconnects a warning', () => {
  assert.deepEqual(keys(evaluateHealth(facts({ collector: { status: 'interrupted' } }))), ['whatsapp:collector']);
  assert.deepEqual(keys(evaluateHealth(facts({ collector: null }))), ['whatsapp:collector']);
  const flapping = { status: 'connected', started_at: AFTERNOON - 10 * HOUR, reconnects: 40 };
  assert.deepEqual(keys(evaluateHealth(facts({ collector: flapping }))), ['whatsapp:reconnects']);
});

test('only retryable job failures left alone for a day count as stuck', () => {
  const findings = evaluateHealth(facts({ failedJobs: [
    { code: 'fetch_failed', count: 2, oldestAttemptAt: AFTERNOON - 30 * HOUR },
    { code: 'fetch_failed_recent', count: 5, oldestAttemptAt: AFTERNOON - HOUR },
  ] }));
  assert.deepEqual(keys(findings), ['jobs:stuck-retries']);
  assert.match(findings[0].title, /^2 משרות/);
});

test('a LinkedIn search failing for half a day is a finding; a late schedule is quiet during a known cooldown', () => {
  const failing = [{ key: 'backend', lastStatus: 'failed', lastReason: 'rate_limited', lastSuccessAt: AFTERNOON - 20 * HOUR }];
  assert.deepEqual(keys(evaluateHealth(facts({ linkedinSearches: failing }))), ['linkedin-search:backend']);
  const quiet = { lastRuns: { ats: { finishedAt: AFTERNOON - HOUR }, linkedin: { finishedAt: AFTERNOON - 9 * HOUR } } };
  assert.deepEqual(keys(evaluateHealth(facts({ ...quiet, linkedinBlockedUntil: AFTERNOON + HOUR }))), []);
  assert.deepEqual(keys(evaluateHealth(facts(quiet))), ['stale:linkedin']);
});

function tempStore(context) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-health-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = createJobStore(path.join(tempDir, 'jobs.db'));
  context.after(() => store.close());
  return store;
}

const notifying = { notifications: { whatsapp: { enabled: true, dashboardUrl: 'http://127.0.0.1:4177/decisions' } } };

test('a finding alerts once when it opens, stays open while it persists, and closes when gone', (context) => {
  const store = tempStore(context);
  // An empty database at night: only "the collector never ran" is wrong.
  const first = runHealthCheck({ store, config: notifying, now: NIGHT });
  assert.deepEqual(keys(first.findings), ['whatsapp:collector']);
  assert.equal(first.alerted, true);
  const [alert] = store.listPendingNotifications({ now: NIGHT });
  assert.match(alert.text, /^⚠️ jobOps: בעיה חדשה\n• אוסף ה-WhatsApp לא מחובר\nלפרטים: http:\/\/127\.0\.0\.1:4177\/scan$/);

  const again = runHealthCheck({ store, config: notifying, now: NIGHT + HOUR });
  assert.equal(again.opened.length, 0);
  assert.equal(again.alerted, false, 'a persisting problem is not re-sent');
  assert.equal(store.listHealthFindings()[0].firstSeenAt, NIGHT);
  assert.equal(store.getHealthCheckedAt(), NIGHT + HOUR);

  const resolved = store.saveHealthFindings([], NIGHT + 2 * HOUR);
  assert.deepEqual(resolved, []);
  assert.deepEqual(store.listHealthFindings(), []);
  assert.equal(store.listHealthFindings({ includeResolved: true })[0].resolvedAt, NIGHT + 2 * HOUR);
});

test('no alert when notifications are off or the finding is only informational', (context) => {
  const store = tempStore(context);
  assert.equal(runHealthCheck({ store, config: {}, now: NIGHT }).alerted, false);
  assert.equal(runHealthCheck({ store, config: notifying, now: NIGHT, notify: false }).alerted, false);
  assert.deepEqual(store.listPendingNotifications({ now: NIGHT }), []);
});

test('a failed Codex call keeps its reason for later diagnosis', (context) => {
  const store = tempStore(context);
  store.recordCodexCall({ purpose: 'scoring', ok: false, errorCode: 'failed', errorReason: 'stream disconnected before completion', at: NIGHT });
  store.recordCodexCall({ purpose: 'scoring', ok: true, errorReason: 'ignored on success', at: NIGHT + 1 });
  const calls = store.listHealthFacts({ now: NIGHT + 2 }).codexCalls;
  assert.deepEqual(calls.map((call) => [call.ok, call.errorReason]), [[1, null], [0, 'stream disconnected before completion']]);
});

const partialWhatsApp = [{
  source: 'whatsapp', candidates: [], diagnostics: {},
  groups: [{ name: 'Group A', found: true, messages: 0, candidates: 0, error: null, coverage: { status: 'partial' }, read: { status: 'skipped' } }],
}];

test('partial WhatsApp history does not make a run incomplete when the live collector covered the window', () => {
  const covered = summarizeSourceResults(partialWhatsApp, { windowFrom: 1_000, liveSince: 500 });
  assert.equal(covered.whatsapp.coverageStatus, 'complete');
  assert.equal(covered.whatsapp.coveredBy, 'live_collector');
  assert.equal(covered.whatsapp.warning, null);
  assert.equal(completionStatusFor(covered), 'success');

  // Connected only after the window started, or not connected: still incomplete.
  for (const context of [{ windowFrom: 1_000, liveSince: 2_000 }, { windowFrom: 1_000, liveSince: null }, {}]) {
    assert.equal(completionStatusFor(summarizeSourceResults(partialWhatsApp, context)), 'incomplete');
  }
});

test('the live collector counts only when connected to every expected group', () => {
  const storeWith = (collector) => ({ getCollectorStatusSummary: () => collector });
  assert.equal(liveCollectorSince(storeWith({ status: 'connected', started_at: 5, groups_found: 4, groups_expected: 4 })), 5);
  assert.equal(liveCollectorSince(storeWith({ status: 'connected', started_at: 5, groups_found: 3, groups_expected: 4 })), null);
  assert.equal(liveCollectorSince(storeWith({ status: 'reconnecting', started_at: 5, groups_found: 4, groups_expected: 4 })), null);
  assert.equal(liveCollectorSince(storeWith(null)), null);
});
