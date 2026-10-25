import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { collectPulse, deriveSignals, lastAtsRun, parseLaunchctlList, sourceKind, summarizePowerLog } from '../scripts/jobs/pulse.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 12:00 in Israel (UTC+3 in October): scheduled hours.
const NOON = Date.parse('2026-10-20T09:00:00Z');

function tempDb(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-pulse-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.db');
  createJobStore(file).close();
  const db = new Database(file);
  context.after(() => db.close());
  return db;
}

const keys = (signals) => signals.map((signal) => signal.key);

test('launchd rows are matched to the expected agents', () => {
  const rows = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.x.collector\n-\t1\tcom.x.scan\n', ['com.x.collector', 'com.x.scan', 'com.x.missing']);
  assert.deepEqual(rows, [
    { label: 'com.x.collector', loaded: true, pid: 123, lastExit: 0 },
    { label: 'com.x.scan', loaded: true, pid: null, lastExit: 1 },
    { label: 'com.x.missing', loaded: false, pid: null, lastExit: null },
  ]);
});

test('power log counts sleeps and dark wakes since the cutoff, with local hours', () => {
  const log = [
    '2026-10-19 08:00:00 +0300 Sleep               \tEntering Sleep state',
    '2026-10-20 02:00:00 +0300 Sleep               \tEntering Sleep state due to Idle',
    '2026-10-20 02:15:00 +0300 DarkWake            \tDarkWake from Deep Idle',
    '2026-10-20 10:30:00 +0300 Sleep               \tEntering Sleep state',
    'garbage line',
  ].join('\n');
  assert.deepEqual(summarizePowerLog(log, Date.parse('2026-10-19T12:00:00Z')), {
    sleeps: 2, darkWakes: 1, lastSleepAt: '2026-10-20T07:30:00.000Z', sleepHoursLocal: [2, 10],
  });
});

test('the last ATS block of the log gives the error ratio', () => {
  const log = 'ATS: 70 מועמדויות מתוך 4700 משרות ב-107 חברות; 0 שגיאות.\nreports/daily/a.md\n'
    + 'ATS: 0 מועמדויות מתוך 0 משרות ב-125 חברות; 125 שגיאות.\nהדוח נשמר: reports/daily/2026-10-14T11-08-32-898Z.md\n';
  assert.deepEqual(lastAtsRun(log), { candidates: 0, jobs: 0, companies: 125, errors: 125, report: '2026-10-14T11-08-32-898Z' });
  assert.equal(lastAtsRun(''), null);
});

test('a job is attributed to LinkedIn by URL, else to its sources, else to its latest sighting', () => {
  assert.equal(sourceKind('["WhatsApp: Group"]', 'https://www.linkedin.com/jobs/view/4400000001'), 'linkedin');
  assert.equal(sourceKind('["ATS: greenhouse"]', 'https://boards.greenhouse.io/x/jobs/1'), 'ats');
  assert.equal(sourceKind('[]', 'https://x.com/job/1', 'whatsapp'), 'whatsapp');
  assert.equal(sourceKind('[]', 'https://x.com/job/1', null), 'unknown');
});

test('a healthy snapshot has no error or warning signals', () => {
  const signals = deriveSignals({
    services: [{ label: 'a', loaded: true, pid: 1, lastExit: 0 }],
    collector: { status: 'connected', heartbeatMinutesAgo: 1, reconnectsLast6h: 6, connectFailuresLast6h: 0, decryptFailuresLast6h: 2 },
    whatsapp: { lastGroupMessageMinutesAgo: 10, backlogPending: 3, backlogOldestMinutes: 20 },
    alerts: { unsent: 0, expiredUnsentLast7d: 0 },
    linkedin: { cooldown: null, refusals24h: {}, requests: { last24h: [{ kind: 'posting', n: 40 }, { kind: 'search', n: 30 }], lastSearchMinutesAgo: 90, busiestHourLast24h: { n: 8 }, refusals: [] }, hourlyCap: 10, queue: { linkedin_deferred: 100 } },
    ats: { companies: 118, errors: 2, logUpdatedMinutesAgo: 30 },
    codex: { calls24h: 10, failed24h: 0 },
    runs: { stuck: [] },
    machine: { onAC: true, last24h: { sleepHoursLocal: [2, 3] }, egress: { warp: 'off' } },
    jobs: { read24h: { ats: { evaluated: 5, newSuitable: 1 } } },
    health: [],
  }, { now: NOON });
  assert.deepEqual(signals, []);
});

test('the failure patterns seen in October each raise their own signal', () => {
  const signals = deriveSignals({
    services: [{ label: 'com.amirgefen.jobops.linkedin-queue', loaded: false }, { label: 'scan', loaded: true, pid: null, lastExit: 1 }],
    collector: { status: 'reconnecting', heartbeatMinutesAgo: 1, reconnectsLast6h: 40, connectFailuresLast6h: 30, decryptFailuresLast6h: 100, lastDisconnect: { code: 'network_error' } },
    whatsapp: { lastGroupMessageMinutesAgo: 600, backlogPending: 0 },
    alerts: { unsent: 4, oldestUnsentMinutes: 120, expiredUnsentLast7d: 15 },
    linkedin: { cooldown: { reason: 'rate_limited', until: 'x' }, refusals24h: { linkedin_rate_limited: 2, linkedin_blocked: 1 }, requests: { last24h: [], busiestHourLast24h: { n: 14 } }, requestLogSince: '2026-10-19T09:00:00Z', hourlyCap: 10, queue: { linkedin_deferred: 180 } },
    ats: { companies: 125, errors: 125, report: 'r', logUpdatedMinutesAgo: 200 },
    codex: { calls24h: 9, failed24h: 6, lastFailure: { code: 'timeout' } },
    runs: { stuck: [{ id: 534, sources: '["ats"]', stage: 'page-fetch', heartbeatMinutesAgo: 70 }] },
    machine: { onAC: false, last24h: { sleeps: 10, sleepHoursLocal: [9, 14], lastSleepAt: 'x' }, egress: { warp: 'on' } },
    jobs: { read24h: {} },
    health: [{ key: 'whatsapp:silent', severity: 'error', title: 't' }],
  }, { now: NOON });
  assert.deepEqual(new Set(keys(signals)), new Set([
    'service.not_loaded', 'service.last_exit_failed', 'collector.cannot_connect', 'collector.flapping', 'collector.decrypt_failures',
    'whatsapp.silent', 'alerts.unsent', 'alerts.expired', 'linkedin.cooldown', 'linkedin.refusals', 'linkedin.over_cap',
    'linkedin.search_starved', 'ats.mass_failure', 'ats.not_running', 'codex.failures', 'runs.stuck', 'machine.on_battery', 'machine.slept', 'network.warp',
    'jobs.none_read', 'health.whatsapp',
  ]));
  assert.equal(signals[0].severity, 'error', 'errors come first');
  // A queue with no reads is stalled only when LinkedIn is not cooling down.
  assert.ok(!keys(signals).includes('linkedin.queue_stalled'));
});

test('a logged-out collector says pairing is required; night-time silence is not an alarm', () => {
  assert.deepEqual(keys(deriveSignals({ collector: { status: 'pairing_required' } }, { now: NOON })), ['collector.pairing_required']);
  const night = Date.parse('2026-10-20T01:00:00Z'); // 04:00 in Israel
  assert.deepEqual(keys(deriveSignals({ collector: { status: 'connected', heartbeatMinutesAgo: 1 }, whatsapp: { lastGroupMessageMinutesAgo: 400 } }, { now: night })), []);
});

test('the snapshot reads the real schema: LinkedIn requests, deliverable vs expired alerts, reads per source', (context) => {
  const db = tempDb(context);
  const now = NOON;
  db.prepare('INSERT INTO linkedin_requests (at, kind) VALUES (?, ?)').run(now - 10 * MIN, 'posting');
  db.prepare('INSERT INTO linkedin_requests (at, kind) VALUES (?, ?)').run(now - 2 * HOUR, 'search');
  db.prepare("INSERT INTO notification_outbox (job_key, text, created_at, attempts) VALUES ('a', 'x', ?, 0)").run(now - 2 * HOUR);
  db.prepare("INSERT INTO notification_outbox (job_key, text, created_at, attempts) VALUES ('b', 'x', ?, 0)").run(now - 3 * 24 * HOUR);
  const insertJob = db.prepare(`INSERT INTO jobs (job_key, canonical_url, apply_url, sources_json, first_seen_at, last_seen_at, evaluated_at, first_suitable_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insertJob.run('li', 'https://www.linkedin.com/jobs/view/4400000001', 'https://www.linkedin.com/jobs/view/4400000001', '[]', now - HOUR, now - HOUR, now - HOUR, now - HOUR);
  insertJob.run('ats', 'https://boards.greenhouse.io/x/jobs/1', 'https://boards.greenhouse.io/x/jobs/1', '["ATS: greenhouse"]', now - HOUR, now - HOUR, now - HOUR, null);

  const pulse = collectPulse({ db, config: { sources: { linkedin: { limits: { maxRequestsPerHour: 10 } } } }, now, launchctlText: '', egress: { warp: 'off' } });
  assert.deepEqual(pulse.linkedin.requests.last1h, [{ kind: 'posting', n: 1 }]);
  assert.equal(pulse.linkedin.postingsEvaluated24h, 1);
  assert.deepEqual(pulse.alerts, { unsent: 1, oldestUnsentMinutes: 120, expiredUnsentLast7d: 1 });
  assert.deepEqual(pulse.jobs.read24h, { linkedin: { evaluated: 1, newSuitable: 1 }, ats: { evaluated: 1, newSuitable: 0 } });
  assert.equal(pulse.collector.status, 'never_ran');
  assert.ok(keys(pulse.signals).includes('collector.down'));
  assert.ok(keys(pulse.signals).includes('alerts.unsent'));
  // Every section is present even when its data is empty.
  for (const name of ['services', 'machine', 'collector', 'whatsapp', 'alerts', 'linkedin', 'ats', 'codex', 'runs', 'jobs', 'health']) {
    assert.ok(name in pulse, name);
    assert.equal(pulse[name]?.error, undefined, `${name}: ${pulse[name]?.error}`);
  }
});

test('LinkedIn refusals are kept with the load before them, and do not count toward the cap', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-pulse-refusal-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const at = NOON - 30 * MIN;
  // A posting 7 hours earlier: the request log covers enough time to judge searches.
  store.recordLinkedInRequest({ kind: 'posting', at: at - 7 * HOUR });
  for (const offset of [9, 6, 3]) store.recordLinkedInRequest({ kind: 'posting', at: at - offset * MIN });
  store.noteLinkedInBlock('rate_limited', { at, cooldownMs: 20 * MIN });
  assert.equal(store.countLinkedInRequests({ since: 0 }), 4, 'the refusal is history, not a request');

  const db = new Database(path.join(dir, 'jobs.db'), { readonly: true });
  context.after(() => db.close());
  const pulse = collectPulse({ db, config: { sources: { linkedin: { limits: { maxRequestsPerHour: 10 } } } }, now: NOON, launchctlText: '' });
  assert.deepEqual(pulse.linkedin.requests.refusals, [{ at: new Date(at).toISOString(), reason: 'rate_limited', lastHour: 3, last10min: 3 }]);
  // A 429 the run recovered from is history, not a problem.
  store.recordLinkedInRefusal({ reason: 'rate_limited', detail: { status: 429, retryAfter: '30', recovered: true }, at: at + MIN });
  const later = collectPulse({ db, config: { sources: { linkedin: { limits: { maxRequestsPerHour: 10 } } } }, now: NOON, launchctlText: '' });
  assert.equal(later.linkedin.requests.refusals[1].recovered, true);
  assert.ok(later.signals.some((item) => item.key === 'linkedin.refusals_recovered'));
  assert.match(later.signals.find((item) => item.key === 'linkedin.refused_under_cap').evidence, /^1 refusals/);
  const signal = pulse.signals.find((item) => item.key === 'linkedin.refused_under_cap');
  assert.match(signal.evidence, /after 3\/h, 3 in 10 min/);
  assert.ok(pulse.signals.some((item) => item.key === 'linkedin.search_starved'), 'no search in 24h during the day');
});
