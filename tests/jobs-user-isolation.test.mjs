import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { up as userOwnedTables } from '../scripts/jobs/store/migrations/007-user-owned-tables.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

function setup(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-isolation-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.db');
  const first = createJobStore(file);
  context.after(() => first.close());
  const raw = new Database(file);
  context.after(() => raw.close());
  raw.prepare('INSERT INTO users (id, created_at) VALUES (2, 1)').run();
  const second = createJobStore(file, { userId: 2 });
  context.after(() => second.close());
  return { first, second, raw, file };
}

async function suitableJob(store, index) {
  const url = `https://example.com/jobs/${index}`;
  const { jobKey } = await store.recordSighting({ url, company: `Co${index}`, title: 'Dev', source: 'ATS: X' });
  await store.saveEvaluation(jobKey, { company: `Co${index}`, title: 'Dev', summary: 's', score: 4, fitLabel: 'x', decisionReason: 'r', suitable: true, applyUrl: url, activeStatus: 'active', contentHash: 'c', profileHash: 'p', criteriaVersion: 'v', evaluatedAt: 1 });
  return jobKey;
}

test('decisions and company blocks belong to the person who made them', async (context) => {
  const { first, second } = setup(context);
  const jobKey = await suitableJob(first, 1);
  await first.decideJob(jobKey, 'company_not_interesting');
  assert.equal((await first.listJobDecisions()).length, 1);
  assert.deepEqual(await second.listJobDecisions(), []);
  assert.equal(await first.isCompanyBlocked('Co1'), true);
  assert.equal(await second.isCompanyBlocked('Co1'), false);
  assert.deepEqual(await second.listBlockedCompanies(), []);
  const [{ key }] = await first.listBlockedCompanies();
  assert.equal(await second.unblockCompany(key), false, 'another user cannot undo it');
  assert.equal(await first.isCompanyBlocked('Co1'), true);
});

test('gap statuses, coverage and observations are separate', async (context) => {
  const { first, second } = setup(context);
  await first.setGapTermStatus('Kafka', 'hidden');
  assert.deepEqual(await second.listGapTermStatuses(), []);
  await second.setGapTermStatus('Kafka', 'in_progress');
  assert.equal((await first.listGapTermStatuses())[0].status, 'hidden');
  await second.setGapTermStatus('Kafka', null);
  assert.equal((await first.listGapTermStatuses()).length, 1, 'clearing one user leaves the other');

  await first.saveGapTermCoverage('key-a', [{ termKey: 'kafka', covered: true }]);
  await second.saveGapTermCoverage('key-b', [{ termKey: 'kafka', covered: false }]);
  assert.equal((await first.listGapTermCoverage('key-a')).get('kafka'), true, "a new resume of one user keeps the other's answers");
  assert.equal((await second.listGapTermCoverage('key-a')).size, 0);

  const jobKey = await suitableJob(first, 2);
  await first.saveResumeGap(jobKey, { analysis: { items: [] }, inputHash: 'h', resumeHash: 'r', analyzedAt: 1 });
  assert.equal((await first.listGapObservations()).length, 1);
  assert.deepEqual(await second.listGapObservations(), []);
});

test('weekly reports and alerts are per person, and the same job can alert two people', async (context) => {
  const { first, second } = setup(context);
  await first.saveWeeklyReport({ weekStart: '2026-11-01', snapshot: { a: 1 }, status: 'analyzed' });
  assert.equal(await second.getWeeklyReport(), null);
  await second.saveWeeklyReport({ weekStart: '2026-11-01', snapshot: { a: 2 }, status: 'analyzed' });
  assert.equal((await first.getWeeklyReport()).snapshot.a, 1);
  await second.markWeeklyReportSent('2026-11-01');
  assert.equal((await first.getWeeklyReport()).sentAt, null);

  assert.equal(await first.enqueueJobNotification({ jobKey: 'j', text: 'one' }), true);
  assert.equal(await first.enqueueJobNotification({ jobKey: 'j', text: 'again' }), false, 'once per person');
  assert.equal(await second.enqueueJobNotification({ jobKey: 'j', text: 'two' }), true);
  const [mine] = await first.listPendingNotifications();
  assert.equal(mine.text, 'one', "the collector sends only the owner's alerts");
  await second.markNotificationSent(mine.id);
  assert.equal((await first.listPendingNotifications()).length, 1, "another user can't mark mine sent");
});

test('statistics count one person', async (context) => {
  const { first, second } = setup(context);
  await first.decideJob(await suitableJob(first, 3), 'applied');
  const facts = await second.weeklySnapshotFacts(Date.now());
  assert.deepEqual(facts.decisions, []);
  assert.equal((await first.weeklySnapshotFacts(Date.now())).decisions.length, 1);
});

test('rows from before accounts belong to the local user, with nothing lost', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-isolation-migrate-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'old.db'));
  context.after(() => db.close());
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 1);
    CREATE TABLE job_decisions (
      job_key TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK(decision IN ('applied')),
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX job_decisions_decided_idx ON job_decisions(decided_at);
    INSERT INTO job_decisions VALUES ('k', 'applied', 5);
    CREATE TABLE blocked_companies (company_key TEXT PRIMARY KEY, name TEXT NOT NULL, blocked_at INTEGER NOT NULL);
    CREATE TABLE gap_observations (job_key TEXT PRIMARY KEY, x TEXT);
    CREATE TABLE gap_term_statuses (term_key TEXT PRIMARY KEY, x TEXT);
    CREATE TABLE weekly_reports (week_start TEXT PRIMARY KEY, x TEXT);
    CREATE TABLE gap_term_coverage (coverage_key TEXT NOT NULL, term_key TEXT NOT NULL, PRIMARY KEY (coverage_key, term_key));
    CREATE TABLE notification_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_key     TEXT NOT NULL UNIQUE,
      text        TEXT NOT NULL
    );
    INSERT INTO notification_outbox (id, job_key, text) VALUES (7, 'j', 't');
  `);
  userOwnedTables(db);
  assert.deepEqual(db.prepare('SELECT user_id, job_key, decision, decided_at FROM job_decisions').all(), [{ user_id: 1, job_key: 'k', decision: 'applied', decided_at: 5 }]);
  assert.throws(() => db.prepare("INSERT INTO job_decisions (job_key, decision, decided_at) VALUES ('x', 'nonsense', 1)").run(), /CHECK/, 'the CHECK list survives');
  assert.deepEqual(db.prepare('SELECT user_id, id, job_key FROM notification_outbox').all(), [{ user_id: 1, id: 7, job_key: 'j' }]);
  assert.equal(db.prepare("INSERT INTO notification_outbox (job_key, text) VALUES ('new', 't')").run().lastInsertRowid, 8, 'ids keep growing');
});
