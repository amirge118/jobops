import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { recordApplication } from '../scripts/jobs/tracker.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const TABLE = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];
const row = (number, company, role, status) => `| ${number} | 2026-08-01 | ${company} | ${role} | 4.0/5 | ${status} | ❌ | [${number}](reports/${number}.md) | n |`;
const entry = { company: 'Acme', title: 'Backend Engineer', score: 4.4, date: '2026-10-05', applyUrl: 'https://acme.test/1' };

test('a new application gets the next number after the last row', () => {
  const result = recordApplication([...TABLE, row('009', 'Other', 'X', 'Evaluated'), row('012', 'Other', 'Y', 'SKIP'), ''].join('\n'), entry);
  assert.equal(result.action, 'added');
  assert.equal(result.number, '013');
  assert.match(result.markdown.trim().split('\n').at(-1),
    /^\| 013 \| 2026-10-05 \| Acme \| Backend Engineer \| 4\.4\/5 \| Applied \| ❌ \| — \| Applied 2026-10-05 \(dashboard\)\. https:\/\/acme\.test\/1 \|$/);
});

test('the same company and role is updated in place, never duplicated', () => {
  const result = recordApplication([...TABLE, row('003', 'Acme Ltd.', 'Backend Engineer', 'SKIP'), ''].join('\n'), entry);
  assert.equal(result.action, 'updated');
  assert.match(result.markdown, /\| 003 \| 2026-08-01 \| Acme Ltd\. \| Backend Engineer \| 4\.0\/5 \| Applied \| .* n Applied 2026-10-05 \(dashboard\)\. \|/);
  assert.equal(result.markdown.match(/^\| \d/gm).length, 1);
});

test('a status past Applied is never moved back', () => {
  const markdown = [...TABLE, row('003', 'Acme', 'Backend Engineer', 'Interview'), ''].join('\n');
  assert.deepEqual(recordApplication(markdown, entry), { markdown, action: 'unchanged', number: '003' });
});

test('a missing tracker starts with the header; cell separators in names cannot break the table', () => {
  const result = recordApplication('', { ...entry, company: 'A | B', score: null });
  assert.equal(result.number, '001');
  assert.deepEqual(result.markdown.split('\n').slice(0, 4), TABLE);
  assert.match(result.markdown, /\| 001 \| 2026-10-05 \| A B \| Backend Engineer \| N\/A \| Applied \|/);
});

test('a database from before "applied" existed is migrated without losing decisions', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-decisions-migration-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const file = path.join(tempDir, 'jobs.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE job_decisions (
    job_key TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('interested', 'company_candidate', 'company_not_interesting', 'too_senior', 'not_relevant')),
    decided_at INTEGER NOT NULL, company TEXT, title TEXT, apply_url TEXT, score REAL, fit_label TEXT, fit_json TEXT,
    source_kinds_json TEXT NOT NULL DEFAULT '[]', screen_pass TEXT, criteria_version TEXT, first_seen_at INTEGER
  );
  INSERT INTO job_decisions (job_key, decision, decided_at, company) VALUES ('old', 'interested', 1, 'Acme');`);
  legacy.close();

  const store = createJobStore(file);
  context.after(() => store.close());
  assert.deepEqual(store.listJobDecisions().map((item) => [item.jobKey, item.decision, item.company]), [['old', 'interested', 'Acme']]);
  const db = new Database(file);
  context.after(() => db.close());
  db.prepare("INSERT INTO job_decisions (job_key, decision, decided_at) VALUES ('new1', 'applied', 2), ('new2', 'not_interested', 3)").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM job_decisions').get().count, 3);
});
