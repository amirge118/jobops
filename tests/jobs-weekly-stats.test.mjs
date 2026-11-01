import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { renderScheduledScanAgent, SCHEDULES } from '../scripts/jobs/scheduled-scan-service.mjs';
import {
  MESSAGE_MAX_CHARS, formatWeeklyMessage, parseTrackerOutcomes, runWeeklyStats, weekStartOf,
} from '../scripts/jobs/weekly-stats.mjs';

const Database = createRequire(import.meta.url)('better-sqlite3');
const DAY = 24 * 60 * 60 * 1000;
// Wednesday 2026-10-28, 12:00 in Israel.
const NOW = Date.parse('2026-10-28T10:00:00Z');

const CONFIG = {
  decision: { criteriaVersion: 'v-test', minimumScore: 3.6 },
  sources: {
    whatsapp: { groups: [{ name: 'Busy Group', jid: 'busy@g.us' }, { name: 'Quiet Group', jid: 'quiet@g.us' }] },
    linkedin: { searches: [{ label: 'Backend' }, { label: 'Old', enabled: false }] },
  },
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-weekly-'));
  const dbPath = path.join(dir, 'jobs.db');
  const store = createJobStore(dbPath);
  const db = new Database(dbPath);
  return { store, db, cleanup: () => { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const collect = async () => ({ decisionStats: { windows: { '7d': { total: 4, positive: 2 } } }, trackerMarkdown: '', gaps: [], signals: [] });

test('the week starts on Sunday, Israel time', () => {
  assert.equal(weekStartOf(NOW), '2026-10-25');
  assert.equal(weekStartOf(Date.parse('2026-10-24T22:30:00Z')), '2026-10-25'); // Sunday 01:30 in Israel
});

test('per-group and per-search yield come from the durable source labels, quiet groups included', async () => {
  const { store, db, cleanup } = setup();
  try {
    const wanted = await store.recordSighting({ url: 'https://example.com/jobs/1', company: 'A', title: 'Backend', source: 'WhatsApp: Busy Group', seenAt: NOW - DAY });
    await store.recordSighting({ url: 'https://example.com/jobs/2', company: 'B', title: 'AI', source: 'LinkedIn: Backend', seenAt: NOW - 10 * DAY });
    // Rejection clears sources_json; the label must survive it.
    db.prepare("UPDATE jobs SET sources_json = '[]', first_suitable_at = ? WHERE job_key = ?").run(NOW - DAY, wanted.jobKey);
    db.prepare("INSERT INTO job_decisions (job_key, decision, decided_at, company) VALUES (?, 'applied', ?, 'A')").run(wanted.jobKey, NOW - DAY);
    db.prepare("INSERT INTO processed_messages (message_id, group_jid, wa_timestamp, status, updated_at) VALUES ('m1', 'busy@g.us', ?, 'done', ?)").run(NOW - DAY, NOW);

    const { snapshot } = await runWeeklyStats({ store, config: CONFIG, now: NOW, collect, analyze: async () => null, send: false });
    const busy = snapshot.whatsappGroups.find((group) => group.label === 'WhatsApp: Busy Group');
    const quiet = snapshot.whatsappGroups.find((group) => group.label === 'WhatsApp: Quiet Group');
    assert.deepEqual(busy.week, { jobs: 1, suitable: 1, interesting: 1 });
    assert.deepEqual(busy.messages, { week: 1, month: 1 });
    assert.deepEqual(quiet.month, { jobs: 0, suitable: 0, interesting: 0 });
    const backend = snapshot.linkedinSearches.find((search) => search.label === 'LinkedIn: Backend');
    assert.deepEqual([backend.week.jobs, backend.month.jobs], [0, 1]);
    assert.ok(!snapshot.linkedinSearches.some((search) => search.label === 'LinkedIn: Old'));
  } finally { cleanup(); }
});

test('the scheduled run queues one WhatsApp summary per week and skips a second run', async () => {
  const { store, db, cleanup } = setup();
  try {
    const analysis = { headline: 'שבוע טוב', recommendations: [{ action: 'להוסיף את Datadog' }] };
    const first = await runWeeklyStats({ store, config: CONFIG, now: NOW, collect, analyze: async () => analysis });
    assert.equal(first.status, 'analyzed');
    assert.equal(first.queued, true);
    assert.match(first.text, /שבוע טוב/);
    assert.match(first.text, /1\. להוסיף את Datadog/);

    const second = await runWeeklyStats({ store, config: CONFIG, now: NOW + DAY, collect, analyze: async () => analysis });
    assert.equal(second.skipped, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE job_key LIKE 'weekly:%'").get().n, 1);
  } finally { cleanup(); }
});

test('a Codex failure still sends a rule-based summary, marked as such', async () => {
  const { store, db, cleanup } = setup();
  try {
    const result = await runWeeklyStats({
      store, config: CONFIG, now: NOW, collect, analyze: async () => { throw new Error('codex exec failed: usage limit'); },
    });
    assert.equal(result.status, 'fallback');
    assert.equal(result.queued, true);
    assert.match(result.text, /בלי ניתוח Codex/);
    assert.match(result.snapshot.analysisError, /usage limit/);
    assert.ok(result.analysis.recommendations.some((item) => /Quiet Group/.test(item.action)));
    // Per-group tracking has not covered a month yet: a check, never a removal.
    assert.equal(result.snapshot.labelTrackingComplete, false);
    assert.ok(!result.analysis.recommendations.some((item) => /להסיר/.test(item.action)));
    assert.equal((await store.getWeeklyReport()).status, 'fallback');
  } finally { cleanup(); }
});

test('week-over-week numbers compare with the previous stored week', async () => {
  const { store, db, cleanup } = setup();
  try {
    await store.saveWeeklyReport({ weekStart: '2026-10-18', snapshot: { decisions: { week: { total: 1, positive: 0 } }, found: { suitable: 3 } }, status: 'analyzed', at: NOW - 7 * DAY });
    const result = await runWeeklyStats({ store, config: CONFIG, now: NOW, collect, analyze: async () => ({ headline: 'x', recommendations: [] }) });
    assert.equal(result.snapshot.previous.weekStart, '2026-10-18');
    assert.match(result.text, /החלטות: 4 \(\+3\)/);
    assert.match(result.text, /עניינו אותך: 2 \(\+2\)/);
  } finally { cleanup(); }
});

test('an overlapping previous report is not shown as a week-over-week change', async () => {
  const { store, db, cleanup } = setup();
  try {
    await store.saveWeeklyReport({ weekStart: '2026-10-18', snapshot: { generatedAt: NOW - 4 * DAY, decisions: { week: { total: 1, positive: 0 } }, found: { suitable: 3 } }, status: 'analyzed', at: NOW - 4 * DAY });
    const result = await runWeeklyStats({ store, config: CONFIG, now: NOW, collect, analyze: async () => ({ headline: 'x', recommendations: [] }) });
    assert.equal(result.snapshot.previous.comparable, false);
    assert.equal(result.snapshot.previous.overlapDays, 3);
    assert.match(result.text, /החלטות: 4(?! \()/);
  } finally { cleanup(); }
});

test('a later slot retries a failed analysis: failure changes nothing, success sends once more', async () => {
  const { store, db, cleanup } = setup();
  const outbox = () => db.prepare("SELECT job_key FROM notification_outbox WHERE job_key LIKE 'weekly:%' ORDER BY id").all().map((row) => row.job_key);
  try {
    const fail = async () => { throw new Error('Codex scoring timed out'); };
    await runWeeklyStats({ store, config: CONFIG, now: NOW, collect, analyze: fail });
    const sentAt = (await store.getWeeklyReport()).sentAt;

    const retryFailed = await runWeeklyStats({ store, config: CONFIG, now: NOW + 1000, collect, analyze: fail });
    assert.equal(retryFailed.skipped, true);
    assert.equal((await store.getWeeklyReport()).createdAt, NOW);
    assert.deepEqual(outbox(), ['weekly:2026-10-25']);

    const retried = await runWeeklyStats({ store, config: CONFIG, now: NOW + 2000, collect, analyze: async () => ({ headline: 'ניתוח מלא', recommendations: [] }) });
    assert.equal(retried.status, 'analyzed');
    assert.equal((await store.getWeeklyReport()).status, 'analyzed');
    assert.ok((await store.getWeeklyReport()).sentAt >= sentAt);
    assert.deepEqual(outbox(), ['weekly:2026-10-25', 'weekly:2026-10-25:analysis']);

    let calls = 0;
    const after = await runWeeklyStats({ store, config: CONFIG, now: NOW + 3000, collect, analyze: async () => { calls += 1; return null; } });
    assert.equal(after.skipped, true);
    assert.equal(calls, 0);
  } finally { cleanup(); }
});

test('the message stays under the WhatsApp length cap', () => {
  const long = { headline: 'א'.repeat(2_000), recommendations: [] };
  assert.ok(formatWeeklyMessage({ weekStart: '2026-10-25', found: {}, retention: [] }, long).length <= MESSAGE_MAX_CHARS);
});

test('retention is only a proposal; apply touches exactly the named categories', async () => {
  const { store, db, cleanup } = setup();
  try {
    const old = NOW - 90 * DAY;
    const kept = await store.recordSighting({ url: 'https://example.com/jobs/9', company: 'C', title: 'Backend', source: 'WhatsApp: Busy Group', seenAt: old });
    db.prepare('UPDATE jobs SET archived_at = ?, evaluated_at = ? WHERE job_key = ?').run(old, old, kept.jobKey);
    db.prepare("INSERT INTO job_pages (canonical_url, final_url, status, content, content_hash, fetched_at) VALUES (?, ?, 'active', 'old text', 'h', ?)").run(kept.canonicalUrl, kept.canonicalUrl, old);
    db.pragma('foreign_keys = OFF'); // an event without its run row is enough here
    db.prepare('INSERT INTO collector_events (collector_run_id, stage, status, created_at) VALUES (1, ?, ?, ?)').run('connect', 'complete', old);

    const proposal = Object.fromEntries((await store.retentionProposal({ now: NOW })).map((entry) => [entry.category, entry.rows]));
    assert.equal(proposal.page_content, 1);
    assert.equal(proposal.collector_events, 1);
    assert.equal(db.prepare('SELECT content FROM job_pages').get().content, 'old text'); // a proposal changes nothing

    assert.deepEqual(await store.applyRetention(['page_content'], { now: NOW }), [{ category: 'page_content', changed: 1 }]);
    assert.equal(db.prepare('SELECT content FROM job_pages').get().content, '');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collector_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_source_labels').get().n, 1);
    await assert.rejects(async () => await store.applyRetention(['jobs'], { now: NOW }), /Unknown retention categories: jobs/);
  } finally { cleanup(); }
});

test('tracker outcomes count statuses and list applications waiting over a week', () => {
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '| 001 | 2026-10-01 | Acme | Backend | 4.2/5 | Applied | ✅ | | |',
    '| 002 | 2026-10-26 | Beta | AI | 4.0/5 | Applied | ✅ | | |',
    '| 003 | 2026-10-02 | Gamma | Backend | 4.1/5 | Interview | ✅ | | |',
  ].join('\n');
  const outcomes = parseTrackerOutcomes(tracker, { now: NOW });
  assert.equal(outcomes.applied, 2);
  assert.equal(outcomes.interview, 1);
  assert.deepEqual(outcomes.followUpsDue.map((row) => row.company), ['Acme']);
  assert.equal(outcomes.followUpsDueCount, 1);
});

test('the follow-up count is the full number even though the list is capped', async () => {
  const { store, db, cleanup } = setup();
  try {
    const rows = Array.from({ length: 12 }, (_, index) => `| ${index + 1} | 2026-10-01 | Co${index} | Backend | 4/5 | Applied | ✅ | | |`).join('\n');
    const result = await runWeeklyStats({
      store, config: CONFIG, now: NOW, send: false, analyze: async () => null,
      collect: async () => ({ decisionStats: null, trackerMarkdown: rows, gaps: [], signals: [] }),
    });
    assert.equal(result.snapshot.outcomes.followUpsDue.length, 10);
    assert.equal(result.snapshot.outcomes.followUpsDueCount, 12);
    assert.ok(result.analysis.recommendations.some((item) => /לעדכן 12 הגשות/.test(item.action)));
  } finally { cleanup(); }
});

test('the weekly agent fires on Sunday at 08:15', () => {
  const weekly = SCHEDULES.find((schedule) => schedule.key === 'weekly-stats');
  const plist = renderScheduledScanAgent(weekly, { nodePath: '/usr/local/bin/node', rootDir: '/tmp/jobops' });
  assert.match(plist, /<key>Weekday<\/key><integer>0<\/integer><key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>15<\/integer>/);
  assert.match(plist, /weekly-stats\.mjs<\/string><string>--send<\/string>/);
  assert.match(plist, /<array><string>\/usr\/bin\/caffeinate<\/string><string>-is<\/string><string>\/usr\/local\/bin\/node<\/string>/);
  assert.equal(weekly.times.length, 3);
  assert.ok(weekly.times.every((time) => time.weekday === 0));
});
