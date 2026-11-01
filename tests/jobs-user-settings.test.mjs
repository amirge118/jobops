import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { LOCAL_USER_ID, resolveCurrentUser } from '../scripts/jobs/current-user.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { resolveUserSettings, saveUserSetting, USER_SETTINGS } from '../scripts/jobs/user-settings.mjs';

const ENABLED = 'notifications.whatsapp.enabled';
const MIN_SCORE = 'notifications.whatsapp.minScore';

function tempStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-settings-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.db');
  const store = createJobStore(file);
  context.after(() => store.close());
  return { store, file };
}

test('a new database has the local user, and it is the current user', async (context) => {
  const { store } = tempStore(context);
  assert.equal(resolveCurrentUser().id, LOCAL_USER_ID);
  assert.equal((await store.getUser(LOCAL_USER_ID)).id, LOCAL_USER_ID);
  assert.equal(await store.getUser(2), null);
});

test('a setting resolves from the database, then the config file, then the default', async (context) => {
  const { store } = tempStore(context);
  const config = { notifications: { whatsapp: { minScore: 3.5 } } };
  let settings = await resolveUserSettings(store, LOCAL_USER_ID, {});
  assert.equal(settings[MIN_SCORE], USER_SETTINGS[MIN_SCORE].fallback);
  settings = await resolveUserSettings(store, LOCAL_USER_ID, config);
  assert.equal(settings[MIN_SCORE], 3.5);
  await saveUserSetting(store, LOCAL_USER_ID, MIN_SCORE, 4.5);
  settings = await resolveUserSettings(store, LOCAL_USER_ID, config);
  assert.equal(settings[MIN_SCORE], 4.5);
  assert.equal(await store.deleteUserSetting(LOCAL_USER_ID, MIN_SCORE), true);
  assert.equal((await resolveUserSettings(store, LOCAL_USER_ID, config))[MIN_SCORE], 3.5);
});

test('a stored false is a real value, not a missing one', async (context) => {
  const { store } = tempStore(context);
  await saveUserSetting(store, LOCAL_USER_ID, ENABLED, false);
  const settings = await resolveUserSettings(store, LOCAL_USER_ID, { notifications: { whatsapp: { enabled: true } } });
  assert.equal(settings[ENABLED], false);
});

test('only listed keys with valid values can be saved', async (context) => {
  const { store } = tempStore(context);
  for (const key of ['decision.criteriaVersion', 'sources.linkedin.limits', '__proto__', 'constructor']) {
    await assert.rejects(saveUserSetting(store, LOCAL_USER_ID, key, 1), { statusCode: 400, code: 'unknown_setting' }, key);
  }
  for (const value of ['4', Number.NaN, Infinity, -1, 5.1, null, {}]) {
    await assert.rejects(saveUserSetting(store, LOCAL_USER_ID, MIN_SCORE, value), { statusCode: 400, code: 'invalid_setting' }, String(value));
  }
  await assert.rejects(saveUserSetting(store, LOCAL_USER_ID, ENABLED, 'yes'), { code: 'invalid_setting' });
  assert.deepEqual(await store.listUserSettings(LOCAL_USER_ID), {});
});

test('a corrupt or removed stored value is ignored, not handed to the scan', async (context) => {
  const { store, file } = tempStore(context);
  const raw = new Database(file);
  context.after(() => raw.close());
  const insert = raw.prepare('INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (1, ?, ?, 1)');
  insert.run(MIN_SCORE, '"not a number"');
  insert.run('removed.setting', 'true');
  const settings = await resolveUserSettings(store, LOCAL_USER_ID, { notifications: { whatsapp: { minScore: 3 } } });
  assert.equal(settings[MIN_SCORE], 3);
  assert.equal('removed.setting' in settings, false);
});

test('one user cannot read or overwrite another user\'s settings', async (context) => {
  const { store, file } = tempStore(context);
  const raw = new Database(file);
  context.after(() => raw.close());
  raw.prepare('INSERT INTO users (id, created_at) VALUES (2, 1)').run();
  await saveUserSetting(store, 1, MIN_SCORE, 3);
  await saveUserSetting(store, 2, MIN_SCORE, 4);
  assert.deepEqual(await store.listUserSettings(1), { [MIN_SCORE]: 3 });
  assert.deepEqual(await store.listUserSettings(2), { [MIN_SCORE]: 4 });
  assert.equal(await store.deleteUserSetting(2, MIN_SCORE), true);
  assert.deepEqual(await store.listUserSettings(1), { [MIN_SCORE]: 3 });
});

test('a setting cannot belong to a user who does not exist', async (context) => {
  const { store } = tempStore(context);
  await assert.rejects(store.saveUserSetting(99, MIN_SCORE, 3), /FOREIGN KEY/);
});
