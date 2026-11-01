import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { MIGRATIONS } from '../scripts/jobs/store/migrations/index.mjs';

const STORE_DIR = path.join('scripts', 'jobs', 'store');
// Reads a legacy database file once to import it; never the live one.
const LEGACY_IMPORT = path.join('scripts', 'migrate-whatsapp-state.mjs');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

test('only the database module loads the driver', () => {
  const offenders = sources('scripts')
    .filter((file) => /better-sqlite3/.test(fs.readFileSync(file, 'utf8')))
    .filter((file) => file !== path.join(STORE_DIR, 'database.mjs') && file !== LEGACY_IMPORT);
  assert.deepEqual(offenders, []);
});

test('SQL lives in the storage layer', () => {
  const offenders = sources('scripts')
    .filter((file) => !file.startsWith(STORE_DIR + path.sep) && file !== LEGACY_IMPORT)
    .filter((file) => /\.prepare\(/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('repositories use only the async database surface', () => {
  const offenders = sources(path.join(STORE_DIR, 'repositories'))
    .filter((file) => /\bdb\.(pragma|raw|backup|function|aggregate)\b/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('every store method is async, so the storage driver can be replaced', async (context) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'jobops-arch-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const notAsync = Object.entries(store)
    .filter(([name, method]) => name !== 'close' && method.constructor.name !== 'AsyncFunction')
    .map(([name]) => name);
  assert.deepEqual(notAsync, []);
  assert.ok(MIGRATIONS.length >= 1);

  // A misspelt or misplaced method only fails when that path runs, so check every caller.
  const missing = sources('scripts')
    .filter((file) => !file.startsWith(STORE_DIR + path.sep) || file.includes('repositories'))
    .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/\bstore\.([a-zA-Z]+)\??\.?\(/g)]
      .map((match) => match[1])
      .filter((name) => !(name in store))
      .map((name) => `${file}: ${name}`));
  assert.deepEqual(missing, []);
});

test('store rows stay plain data', async (context) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'jobops-arch-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const { jobKey } = await store.recordSighting({ url: 'https://example.com/jobs/1', company: 'Acme', title: 'Backend' });
  await store.saveEvaluation(jobKey, { company: 'Acme', title: 'Backend', summary: 's', score: 4, fitLabel: 'fit', decisionReason: 'r',
    suitable: true, applyUrl: 'https://example.com/jobs/1', activeStatus: 'active', contentHash: 'c', profileHash: 'p', criteriaVersion: 'v', evaluatedAt: 1 });
  await store.decideJob(jobKey, 'applied');
  const [decision] = await store.listJobDecisions();
  assert.equal(decision.jobKey, jobKey);
  assert.deepEqual(Object.values(decision).filter((value) => typeof value === 'function'), []);
  await store.syncLinkedInSearches([{ key: 'backend', keywords: 'backend', location: 'Israel' }]);
  const [search] = await store.listLinkedInSearches();
  assert.deepEqual(Object.values(search).filter((value) => typeof value === 'function'), []);
});
