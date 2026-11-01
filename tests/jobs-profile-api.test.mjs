import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDashboardServer } from '../scripts/web.mjs';

const readyService = { inspect: async () => ({ status: 'ready', checkedAt: Date.now(), stale: false, browser: { status: 'ready' }, scorer: { status: 'ready' }, collector: { status: 'ready' } }) };

async function start(context) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-profile-api-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'profile'));
  fs.writeFileSync(path.join(rootDir, 'profile', '01-candidate-profile.md'), '# P\n\n## Identity\n- **Name:** Noa\n- **Phone:** 050\n\n## Summary\nBackend.\n');
  fs.writeFileSync(path.join(rootDir, 'profile', '02-preferences.md'), '# Prefs\n');
  fs.writeFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), '# Noa\n\n## Experience\nBackend at Acme for many years.\n');
  const config = {
    rootDir, jobsDbPath: path.join(rootDir, 'jobs.db'), scan: { defaultLookbackDays: 1, maxLookbackDays: 7 },
    sources: { ats: { enabled: true }, whatsapp: { enabled: true, groups: [] } }, filters: { domains: ['Backend'] },
  };
  const server = await createDashboardServer({ config, readiness: readyService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = (pathname) => fetch(`${base}${pathname}`);
  return { post, get, rootDir };
}

test('the page and its API read and save documents', async (context) => {
  const { post, get, rootDir } = await start(context);
  const overview = await (await get('/api/profile')).json();
  assert.equal(overview.identity.name, 'Noa');
  assert.equal(overview.documents.resume.version, 1);

  const saved = await post('/api/profile/documents/resume', { content: '# Noa\n\n## Experience\nNew text.\n', baseVersion: 1 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).document.version, 2);
  assert.match(fs.readFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), 'utf8'), /New text/);

  const stale = await post('/api/profile/documents/resume', { content: 'x', baseVersion: 1 });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /טען מחדש/);

  const identity = await post('/api/profile/identity', { fields: { phone: '052' }, baseVersion: overview.documents.profile.version });
  assert.equal(identity.status, 200);
  assert.equal((await (await get('/api/profile')).json()).identity.phone, '052');

  const { versions } = await (await get('/api/profile/documents/resume/versions')).json();
  assert.equal(versions.length, 2);
  assert.equal('content' in versions[0], false, 'the list carries no text');
  const version = await (await get('/api/profile/documents/resume/versions/1')).json();
  assert.match(version.document.content, /Backend at Acme/);
  assert.equal((await post('/api/profile/documents/resume/restore', { version: 1, baseVersion: 2 })).status, 200);
});

test('the page exists and is routed', async () => {
  assert.match(fs.readFileSync(new URL('../web/profile.html', import.meta.url), 'utf8'), /data-page="profile"/);
  assert.match(fs.readFileSync(new URL('../scripts/dashboard/static.mjs', import.meta.url), 'utf8'), /\['\/profile', 'profile\.html'\]/);
});

test('unknown kinds, fields and versions are refused', async (context) => {
  const { post, get } = await start(context);
  await get('/api/profile');
  assert.equal((await post('/api/profile/documents/passwords', { content: 'x', baseVersion: null })).status, 404);
  assert.equal((await post('/api/profile/documents/resume', { content: 'x', baseVersion: 1, extra: 1 })).status, 400);
  assert.equal((await post('/api/profile/identity', { fields: { secret: 'x' }, baseVersion: 1 })).status, 400);
  assert.equal((await get('/api/profile/documents/resume/versions/99')).status, 404);
  assert.equal((await post('/api/profile/documents/resume/restore', { version: 99, baseVersion: 1 })).status, 404);
  assert.equal((await post('/api/profile/documents/resume/adopt-file', { x: 1 })).status, 400);
});

test('a large CV fits its own limit, past the default for other routes', async (context) => {
  const { post } = await start(context);
  const content = `# Noa\n\n## Experience\n${'x'.repeat(100_000)}\n`;
  assert.equal((await post('/api/profile/documents/resume', { content, baseVersion: null })).status, 409, 'read past the 32 KB default');
  assert.equal((await post('/api/personal-area/term-status', { term: 'x'.repeat(100_000) })).status, 413);
});

test('the personal area reads the saved CV, not the file', async (context) => {
  const { post, get, rootDir } = await start(context);
  await get('/api/profile');
  fs.writeFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), 'hand edit, not adopted');
  assert.equal((await get('/api/personal-area/insights')).status, 200);
  const overview = await (await get('/api/profile')).json();
  assert.deepEqual(overview.fileDrift, ['resume']);
  assert.equal((await post('/api/profile/documents/resume/adopt-file', {})).status, 200);
  assert.deepEqual((await (await get('/api/profile')).json()).fileDrift, []);
});
