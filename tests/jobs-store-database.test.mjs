import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openSqliteDatabase } from '../scripts/jobs/store/database.mjs';
import { createActionController } from '../scripts/dashboard/actions.mjs';

function tempDatabase(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-database-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openSqliteDatabase(path.join(dir, 'jobs.db'));
  context.after(() => db.close());
  db.raw.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
  return db;
}

const values = async (db) => (await db.prepare('SELECT value FROM items ORDER BY id').all()).map((row) => row.value);
const insert = (db, value) => db.prepare('INSERT INTO items (value) VALUES (?)').run(value);

test('statements return promises and pass positional and named parameters', async (context) => {
  const db = tempDatabase(context);
  const result = insert(db, 'a');
  assert.ok(result instanceof Promise);
  assert.equal((await result).changes, 1);
  assert.equal((await db.prepare('SELECT value FROM items WHERE value = @value').get({ value: 'a' })).value, 'a');
});

test('a failed statement rejects instead of throwing at the call', async (context) => {
  const db = tempDatabase(context);
  const pending = db.prepare('SELECT * FROM missing_table').all();
  await assert.rejects(pending, /no such table/);
});

test('a statement outside a transaction runs at the call, so an exit handler still writes', async (context) => {
  const db = tempDatabase(context);
  insert(db, 'written-now');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
});

test('a transaction commits as one and rolls back whole on failure', async (context) => {
  const db = tempDatabase(context);
  await db.transaction(async () => {
    await insert(db, 'a');
    await insert(db, 'b');
  })();
  assert.deepEqual(await values(db), ['a', 'b']);

  await assert.rejects(db.transaction(async () => {
    await insert(db, 'c');
    throw new Error('boom');
  })(), /boom/);
  assert.deepEqual(await values(db), ['a', 'b']);
});

test('a transaction passes its arguments and returns its result', async (context) => {
  const db = tempDatabase(context);
  const add = db.transaction(async (first, second) => first + second);
  assert.equal(await add(2, 3), 5);
});

test('calls from outside wait for an open transaction instead of joining it', async (context) => {
  const db = tempDatabase(context);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const transaction = db.transaction(async () => {
    await insert(db, 'inside');
    await gate;
    throw new Error('roll back');
  })();
  await new Promise((resolve) => setImmediate(resolve));

  // If this joined the transaction, the rollback would take it along.
  const outside = insert(db, 'outside');
  release();
  await assert.rejects(transaction, /roll back/);
  await outside;
  assert.deepEqual(await values(db), ['outside']);
});

test('concurrent transactions run one after the other', async (context) => {
  const db = tempDatabase(context);
  const order = [];
  const step = (name) => db.transaction(async () => {
    order.push(`${name}:start`);
    await insert(db, name);
    await new Promise((resolve) => setImmediate(resolve));
    order.push(`${name}:end`);
  })();
  await Promise.all([step('a'), step('b'), step('c')]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  assert.deepEqual(await values(db), ['a', 'b', 'c']);
});

test('a nested transaction joins the outer one and undoes only itself on failure', async (context) => {
  const db = tempDatabase(context);
  await db.transaction(async () => {
    await insert(db, 'outer');
    await assert.rejects(db.transaction(async () => {
      await insert(db, 'inner');
      throw new Error('inner failed');
    })(), /inner failed/);
    await db.transaction(async () => insert(db, 'second'))();
  })();
  assert.deepEqual(await values(db), ['outer', 'second']);
});

test('a read-only database refuses writes and needs the file to exist', async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-database-ro-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.db');
  assert.throws(() => openSqliteDatabase(file, { readonly: true }));
  const writer = openSqliteDatabase(file);
  writer.raw.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
  await writer.close();
  const reader = openSqliteDatabase(file, { readonly: true });
  context.after(() => reader.close());
  await assert.rejects(insert(reader, 'x'), /readonly/);
  assert.equal((await reader.prepare('SELECT COUNT(*) AS n FROM items').get()).n, 0);
});

test('two requests at once cannot both start an action', async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-action-claim-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { jobsDbPath: path.join(dir, 'jobs.db'), rootDir: dir, scan: { maxLookbackDays: 7 } };
  let finish;
  const started = [];
  const { startAction } = createActionController(config, (command) => {
    started.push(command);
    return new Promise((resolve) => { finish = resolve; });
  });
  const results = await Promise.allSettled([startAction('scan', { days: 2, source: 'ats', open: false }), startAction('scan', { days: 2, source: 'ats', open: false })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
});
