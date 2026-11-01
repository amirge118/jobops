import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { LOCAL_USER_ID as USER } from '../scripts/jobs/current-user.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { parseTracker, renderTracker, TRACKER_STATUSES } from '../scripts/jobs/tracker/format.mjs';
import { createTrackerService } from '../scripts/jobs/tracker/tracker-service.mjs';
import { createDashboardServer } from '../scripts/web.mjs';

const FILE = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 001 | 2026-07-28 | Traild | Backend, Payments | 3.2/5 | Evaluated | ❌ | [1](reports/1.md) | first |
| 002 | 2026-08-01 | Acme | Backend | 4.2/5 | Applied | ✅ | — | a | b |
| 010 | 2026-08-02 | Beta | AI | 4.0/5 | Interview | ✅ | — |  |
`;
const ENTRY = { company: 'Gamma', title: 'Platform', score: 4.1, date: '2026-11-01', applyUrl: 'https://example.com/1' };

function setup(context, { file = FILE, demo = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-tracker-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'data'));
  if (file !== null) fs.writeFileSync(path.join(rootDir, 'data', 'applications.md'), file);
  const config = { rootDir, jobsDbPath: path.join(rootDir, 'jobs.db'), demo };
  const store = createJobStore(config.jobsDbPath);
  context.after(() => store.close());
  const service = createTrackerService({ store, config, userId: USER });
  return { store, config, service, rootDir, read: () => fs.readFileSync(path.join(rootDir, 'data', 'applications.md'), 'utf8') };
}

test('the file format round-trips exactly', () => {
  const rows = parseTracker(FILE);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].notes, 'a | b', 'a stray pipe in notes is kept');
  assert.equal(rows[2].number, 10);
  assert.equal(rows[2].numberLabel, '010');
  assert.equal(renderTracker(rows), FILE);
});

test('statuses come from templates/states.yml', () => {
  assert.deepEqual(TRACKER_STATUSES, ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP']);
});

test('a file is imported once and keeps every row', async (context) => {
  const { service, read } = setup(context);
  const { rows, fileDrift } = await service.list();
  assert.equal(rows.length, 3);
  assert.equal(fileDrift, false);
  assert.equal(await service.markdown(), FILE);
  assert.equal(read(), FILE, 'importing does not touch the file');
  await service.list();
  assert.equal((await service.list()).rows.length, 3);
});

test('an "applied" decision adds, updates, and never moves a row backwards', async (context) => {
  const { service, read } = setup(context);
  assert.deepEqual(await service.recordApplied(ENTRY), { action: 'added', number: '011' });
  assert.deepEqual(await service.recordApplied(ENTRY), { action: 'unchanged', number: '011' }, 'one row per company and role');
  assert.deepEqual(await service.recordApplied({ company: 'Traild', title: 'Backend, Payments', score: 3.2, date: '2026-11-01' }), { action: 'updated', number: '001' });
  assert.deepEqual(await service.recordApplied({ company: 'Beta', title: 'AI', score: 4, date: '2026-11-01' }), { action: 'unchanged', number: '010' });
  const { rows } = await service.list();
  assert.equal(rows[0].status, 'Applied');
  assert.match(rows[0].notes, /^first Applied 2026-11-01/);
  assert.equal(rows.at(-1).status, 'Applied');
  assert.match(read(), /\| 011 \| 2026-11-01 \| Gamma \| Platform \| 4\.1\/5 \| Applied \|/, 'the copy follows');
});

test('a new user starts empty and cell separators cannot break the table', async (context) => {
  const { service, read } = setup(context, { file: null });
  await service.recordApplied({ company: 'A|B', title: 'x\ny', score: null, date: '2026-11-01' });
  const { rows } = await service.list();
  assert.equal(rows[0].company, 'A B');
  assert.equal(rows[0].role, 'x y');
  assert.equal(rows[0].score, 'N/A');
  assert.equal(rows[0].numberLabel, '001');
  assert.equal(parseTracker(read()).length, 1);
});

test('edits accept canonical statuses only, and a file status never bypasses that', async (context) => {
  const { service } = setup(context);
  await service.list();
  assert.equal((await service.update(1, { status: 'Offer' })).row.status, 'Offer');
  await assert.rejects(service.update(1, { status: 'Applied 2026-01-01' }), { code: 'invalid_status' });
  await assert.rejects(service.update(1, { status: 'applied' }), { code: 'invalid_status' });
  await assert.rejects(service.update(999, { status: 'Offer' }), { statusCode: 404 });
  await assert.rejects(service.update(1, { notes: 5 }), { code: 'invalid_notes' });
  await assert.rejects(service.update(1, { notes: 'x'.repeat(2001) }), { code: 'invalid_notes' });
  assert.equal((await service.update(1, { notes: 'a|b\nc' })).row.notes, 'a b c');
});

test('adding by hand refuses duplicates and bad input', async (context) => {
  const { service } = setup(context);
  assert.equal((await service.add({ company: 'New', role: 'Dev', status: 'Applied', date: '2026-11-01' })).row.numberLabel, '011');
  await assert.rejects(service.add({ company: 'new', role: 'dev', date: '2026-11-01' }), { statusCode: 409, code: 'application_exists' });
  await assert.rejects(service.add({ company: '', role: 'Dev', date: '2026-11-01' }), { code: 'invalid_application' });
  await assert.rejects(service.add({ company: 'X', role: 'Dev', status: 'Nope', date: '2026-11-01' }), { code: 'invalid_status' });
  await assert.rejects(service.add({ company: 'X', role: 'Dev', date: 'tomorrow' }), { code: 'invalid_date' });
});

test('a skill editing the file is noticed, never overwritten, and adopted on request', async (context) => {
  const { service, read, rootDir } = setup(context);
  await service.list();
  const edited = `${FILE}| 011 | 2026-11-01 | Skill | Added | 4.0/5 | Evaluated | ❌ | — | |\n`;
  fs.writeFileSync(path.join(rootDir, 'data', 'applications.md'), edited);
  assert.equal((await service.list()).fileDrift, true);
  assert.equal((await service.update(1, { status: 'Offer' })).fileCopy, 'conflict');
  assert.equal(read(), edited);
  assert.deepEqual(await service.adoptFile(), { rows: 4 });
  const { rows, fileDrift } = await service.list();
  assert.equal(fileDrift, false);
  assert.equal(rows.at(-1).company, 'Skill');
});

test('the demo never touches the real file', async (context) => {
  const { service, read } = setup(context, { demo: true });
  assert.deepEqual((await service.list()).rows, []);
  await service.recordApplied(ENTRY);
  assert.equal(read(), FILE);
  await assert.rejects(service.adoptFile(), { code: 'file_not_found' });
});

test('users never see or change each other\'s applications', async (context) => {
  const { store, config, service } = setup(context);
  const raw = new Database(config.jobsDbPath);
  context.after(() => raw.close());
  raw.prepare('INSERT INTO users (id, created_at) VALUES (2, 1)').run();
  await service.list();
  const other = createTrackerService({ store, config: { ...config, demo: true }, userId: 2 });
  assert.deepEqual((await other.list()).rows, []);
  await assert.rejects(other.update(1, { status: 'Offer' }), { statusCode: 404 });
  await other.recordApplied(ENTRY);
  assert.equal((await other.list()).rows[0].numberLabel, '001', 'numbering is per user');
  assert.equal((await service.list()).rows.length, 3);
});

test('the page API lists, edits and adopts', async (context) => {
  const { config, rootDir } = setup(context);
  Object.assign(config, { scan: { defaultLookbackDays: 1, maxLookbackDays: 7 }, sources: { ats: { enabled: true }, whatsapp: { enabled: true, groups: [] } } });
  const server = await createDashboardServer({ config, readiness: { inspect: async () => ({ status: 'ready' }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const listed = await (await fetch(`${base}/api/tracker`)).json();
  assert.equal(listed.rows.length, 3);
  assert.equal((await post('/api/tracker/1', { status: 'Offer' })).status, 200);
  assert.equal((await post('/api/tracker/1', { status: 'Offer', extra: 1 })).status, 400);
  assert.equal((await post('/api/tracker/0', { status: 'Offer' })).status, 404);
  assert.equal((await post('/api/tracker', { company: 'C', role: 'R', date: '2026-11-01', status: 'Applied' })).status, 200);
  fs.appendFileSync(path.join(rootDir, 'data', 'applications.md'), '\n');
  assert.equal((await (await fetch(`${base}/api/tracker`)).json()).fileDrift, true);
  assert.equal((await post('/api/tracker/adopt-file', {})).status, 200);
});
