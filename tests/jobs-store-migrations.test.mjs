import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { MIGRATIONS, runMigrations } from '../scripts/jobs/store/migrations/index.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

function tempPath(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-migrations-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'jobs.db');
}

test('migration versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((migration) => migration.version);
  assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b));
});

test('a new database records every migration, and reopening runs none again', (context) => {
  const file = tempPath(context);
  createJobStore(file).close();
  const db = new Database(file);
  context.after(() => db.close());
  const applied = () => db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  const before = applied();
  assert.deepEqual(before.map((row) => row.version), MIGRATIONS.map((migration) => migration.version));

  // A row the baseline's cleanup would change: it must survive a later open.
  db.prepare(`INSERT INTO jobs (job_key, canonical_url, apply_url, company, suitable, evaluated_at, sources_json, first_seen_at, last_seen_at)
    VALUES ('k', 'https://example.com/1', 'https://example.com/1', 'Acme', 0, 1, '[]', 1, 1)`).run();
  createJobStore(file).close();
  assert.deepEqual(applied(), before);
  assert.equal(db.prepare("SELECT company FROM jobs WHERE job_key = 'k'").get().company, 'Acme');
});

test('only migrations newer than the database run, in order', (context) => {
  const db = new Database(tempPath(context));
  context.after(() => db.close());
  const ran = [];
  const migration = (version) => ({ version, name: `m${version}`, up: () => ran.push(version) });
  runMigrations(db, [migration(1), migration(2)]);
  runMigrations(db, [migration(1), migration(2), migration(3)]);
  assert.deepEqual(ran, [1, 2, 3]);
});

test('a failing migration rolls back whole and stays unrecorded', (context) => {
  const db = new Database(tempPath(context));
  context.after(() => db.close());
  const failing = {
    version: 1,
    name: 'failing',
    up(handle) {
      handle.exec('CREATE TABLE half_done (id INTEGER)');
      throw new Error('boom');
    },
  };
  assert.throws(() => runMigrations(db, [failing]), /boom/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
});

test('a read-only store writes nothing, schema included', async (context) => {
  const file = tempPath(context);
  assert.throws(() => createJobStore(file, { readonly: true }), /unable to open|does not exist/i, 'never creates a database');
  assert.equal(fs.existsSync(file), false);

  const raw = new Database(file);
  raw.exec('CREATE TABLE unrelated (id INTEGER)');
  raw.close();
  const store = createJobStore(file, { readonly: true });
  context.after(() => store.close());
  const check = new Database(file, { readonly: true });
  context.after(() => check.close());
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0);
  await assert.rejects(async () => await store.setCheckpoint('x', 1), /readonly|no such table/i);
});
