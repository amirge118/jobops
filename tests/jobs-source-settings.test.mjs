import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySourceChange } from '../scripts/dashboard/source-change.mjs';
import { requireOwner } from '../scripts/jobs/current-user.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { saveUserSettings } from '../scripts/jobs/user-settings.mjs';
import { createDashboardServer } from '../scripts/web.mjs';

const JID_A = '120363000000000001@g.us';
const JID_B = '120363000000000002@g.us';
const readyService = { inspect: async () => ({ status: 'ready', checkedAt: Date.now(), stale: false, browser: { status: 'ready' }, scorer: { status: 'ready' }, collector: { status: 'ready' } }) };

async function start(context) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-sources-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const config = {
    rootDir, jobsDbPath: path.join(rootDir, 'jobs.db'), scan: { defaultLookbackDays: 1, maxLookbackDays: 7 },
    sources: { ats: { enabled: true }, whatsapp: { enabled: true, groups: [{ name: 'Configured', jid: JID_A }] }, linkedin: { enabled: true, searches: [{ key: 'backend', label: 'Backend', keywords: 'backend', location: 'Israel' }] } },
    notifications: { whatsapp: { enabled: true, minScore: 4 } },
  };
  const store = createJobStore(config.jobsDbPath);
  context.after(() => store.close());
  await store.saveKnownWhatsAppGroups([{ jid: JID_A, name: 'Jobs IL', participants: 5 }, { jid: JID_B, name: 'Devs', participants: null }]);
  const changes = [];
  const server = await createDashboardServer({ config, readiness: readyService, onSourcesChanged: () => { changes.push(true); return { restarted: true }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (pathname) => (await fetch(`${base}${pathname}`)).json();
  return { post, get, store, config, changes };
}

test('the picker never exposes a WhatsApp address', async (context) => {
  const { get } = await start(context);
  const text = JSON.stringify(await get('/api/sources'));
  assert.equal(text.includes('@g.us'), false);
  assert.equal(text.includes('120363'), false);
  const data = JSON.parse(text);
  assert.deepEqual(data.groups.map(({ name, selected }) => [name, selected]), [['Devs', false], ['Jobs IL', true]]);
});

test('a configured group without an address does not break the page', async (context) => {
  const { store, config } = await start(context);
  config.sources.whatsapp.groups.push({ name: 'No address' });
  const server = await createDashboardServer({ config, readiness: readyService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sources`);
  assert.equal(response.status, 200);
  assert.equal((await store.listKnownWhatsAppGroups()).length, 2);
});

test('groups are chosen by opaque id, known groups only, and restart what reads them', async (context) => {
  const { get, post, store, changes } = await start(context);
  const { groups } = await get('/api/sources');
  const devs = groups.find(({ name }) => name === 'Devs');
  assert.equal((await post('/api/sources/whatsapp/groups', { ids: ['ffffffffffffffff'] })).status, 400);
  assert.equal((await post('/api/sources/whatsapp/groups', { ids: JID_B })).status, 400);
  assert.equal(changes.length, 0, 'refused requests change nothing');
  const saved = await post('/api/sources/whatsapp/groups', { ids: [devs.id] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await store.listUserSettings(1))['sources.whatsapp.groups'], [{ jid: JID_B, name: 'Devs' }]);
  assert.equal(changes.length, 1);
  const after = await saved.json();
  assert.deepEqual(after.groups.filter(({ selected }) => selected).map(({ name }) => name), ['Devs']);
  assert.equal(JSON.stringify(after).includes('@g.us'), false);
});

test('a selected group the account has left stays visible and removable', async (context) => {
  const { get, post, store } = await start(context);
  await store.saveKnownWhatsAppGroups([{ jid: JID_B, name: 'Devs', participants: null }]);
  const { groups } = await get('/api/sources');
  assert.deepEqual(groups.map(({ name, selected }) => [name, selected]), [['Devs', false], ['Configured', true]]);
  assert.equal((await post('/api/sources/whatsapp/groups', { ids: [groups[1].id] })).status, 200, 'keeping it is allowed');
});

test('LinkedIn searches are limited, validated, and replace the configured ones', async (context) => {
  const { post, get } = await start(context);
  const search = (index) => ({ key: `k${index}`, keywords: `role ${index}`, location: 'Israel' });
  assert.equal((await post('/api/sources/linkedin/searches', { searches: Array.from({ length: 7 }, (_, index) => search(index)) })).status, 400);
  for (const bad of [{ key: 'a b', keywords: 'x', location: 'y' }, { key: 'a', keywords: '<script>', location: 'y' }, { key: 'a', keywords: 'x' }, { keywords: 'x', location: 'y' }]) {
    assert.equal((await post('/api/sources/linkedin/searches', { searches: [bad] })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/api/sources/linkedin/searches', { searches: [search(1), search(1)] })).status, 400, 'duplicate keys');
  assert.equal((await post('/api/sources/linkedin/searches', { searches: Array.from({ length: 6 }, (_, index) => search(index)) })).status, 200);
  assert.deepEqual((await get('/api/sources')).linkedinSearches.map(({ key }) => key), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
});

test('sources switch off and on, and only known ones', async (context) => {
  const { post, get } = await start(context);
  assert.equal((await post('/api/sources/ats/enabled', { enabled: 'no' })).status, 400);
  assert.equal((await post('/api/sources/secret/enabled', { enabled: false })).status, 404);
  assert.equal((await (await post('/api/sources/ats/enabled', { enabled: false })).json()).enabled.ats, false);
  assert.equal((await get('/api/sources')).enabled.whatsapp, true);
  assert.equal((await get('/api/sources')).enabled.ats, false);
});

test('notifications save and refuse bad values', async (context) => {
  const { post, get } = await start(context);
  assert.equal((await post('/api/sources/notifications', { minScore: 9 })).status, 400);
  assert.equal((await post('/api/sources/notifications', { enabled: 'x' })).status, 400);
  assert.equal((await post('/api/sources/notifications', { enabled: false, minScore: 4.5 })).status, 200);
  assert.deepEqual((await get('/api/sources')).notifications, { enabled: false, minScore: 4.5 });
});

test('blocked companies can be listed and unblocked', async (context) => {
  const { post, get, store } = await start(context);
  const { jobKey } = await store.recordSighting({ url: 'https://example.com/jobs/1', company: 'BlockedCo', title: 'T', source: 'ATS: X' });
  await store.saveEvaluation(jobKey, { company: 'BlockedCo', title: 'T', summary: 's', score: 4, fitLabel: 'x', decisionReason: 'r', suitable: true, applyUrl: 'https://example.com/jobs/1', activeStatus: 'active', contentHash: 'c', profileHash: 'p', criteriaVersion: 'v', evaluatedAt: 1 });
  await store.decideJob(jobKey, 'company_not_interesting');
  assert.equal(await store.isCompanyBlocked('BlockedCo'), true);
  const { blocked } = await get('/api/companies/blocked');
  assert.equal(blocked[0].company, 'BlockedCo');
  assert.equal((await post('/api/companies/unblock', { key: 'nope' })).status, 404);
  assert.equal((await post('/api/companies/unblock', { key: 5 })).status, 400);
  assert.equal((await post('/api/companies/unblock', { key: blocked[0].key })).status, 200);
  assert.equal(await store.isCompanyBlocked('BlockedCo'), false);
});

test('a saved group list reaches what the scan reads; bad addresses are refused', async (context) => {
  const { store, config } = await start(context);
  await assert.rejects(saveUserSettings(store, 1, { 'sources.whatsapp.groups': [{ name: 'x', jid: 'not-a-group' }] }, config), { code: 'invalid_setting' });
});

test('only the owner changes shared sources', () => {
  assert.throws(() => requireOwner({ id: 2, isOwner: false }), { statusCode: 403, code: 'owner_only' });
  assert.doesNotThrow(() => requireOwner({ id: 1, isOwner: true }));
});

test('a source change restarts the collector, and the dashboard unless it is busy', () => {
  const calls = [];
  const run = (...args) => calls.push(args[1][0]);
  const exits = [];
  const schedule = (callback) => callback();
  assert.deepEqual(applySourceChange({ managed: false, isBusy: () => false, run, exit: (code) => exits.push(code), schedule }), { restarted: false });
  assert.deepEqual(calls, []);
  applySourceChange({ managed: true, isBusy: () => true, run, exit: (code) => exits.push(code), schedule });
  assert.deepEqual(calls, ['kickstart']);
  assert.deepEqual(exits, [], 'an action in progress is not cut off');
  applySourceChange({ managed: true, isBusy: () => false, run, exit: (code) => exits.push(code), schedule });
  assert.equal(exits.length, 1);
});
