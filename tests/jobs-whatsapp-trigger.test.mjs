import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { inspectWhatsAppBacklog, messageJobUrls, shouldProcess, triggerSettings } from '../scripts/jobs/whatsapp-trigger.mjs';

const MINUTE = 60_000;
const now = Date.UTC(2026, 8, 29, 9, 0);
const config = {
  sources: { whatsapp: { enabled: true, groups: [{ name: 'A', jid: 'a@g.us' }, { name: 'B', jid: 'b@g.us' }], trigger: { minNewJobs: 3, maxWaitMinutes: 120 } } },
};

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-trigger-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

test('links are read from messages the same way the collector pipeline reads them', () => {
  assert.deepEqual(messageJobUrls('Apply: https://jobs.lever.co/acme/1. Also (https://boards.greenhouse.io/x/jobs/2) https://jobs.lever.co/acme/1'),
    ['https://jobs.lever.co/acme/1', 'https://boards.greenhouse.io/x/jobs/2']);
  assert.deepEqual(messageJobUrls(null), []);
});

test('the decision waits for a well-filled batch unless the oldest job waited too long', () => {
  const settings = { minNewJobs: 8, maxWaitMinutes: 120 };
  assert.deepEqual(shouldProcess({ newJobs: 0, waitedMinutes: 999, settings }), { run: false, reason: 'nothing_new' });
  assert.deepEqual(shouldProcess({ newJobs: 3, waitedMinutes: 30, settings }), { run: false, reason: 'waiting_for_more' });
  assert.deepEqual(shouldProcess({ newJobs: 8, waitedMinutes: 0, settings }), { run: true, reason: 'enough_jobs' });
  assert.deepEqual(shouldProcess({ newJobs: 1, waitedMinutes: 120, settings }), { run: true, reason: 'waited_too_long' });
  assert.deepEqual(triggerSettings({}), { minNewJobs: 10, maxWaitMinutes: 120, lookbackDays: 7 });
});

test('only unique, unknown job links count as new jobs, and the check changes nothing', () => {
  const store = tempStore();
  store.recordSighting({ url: 'https://jobs.lever.co/acme/known', source: 'ATS: lever-api' });
  const queue = (id, jid, minutesAgo, text) => store.queueWhatsAppMessage({ messageId: id, groupJid: jid, timestamp: now - minutesAgo * MINUTE, text });
  queue('m1', 'a@g.us', 30, 'New role https://jobs.lever.co/acme/1');
  queue('m2', 'b@g.us', 90, 'Same role shared again https://jobs.lever.co/acme/1?utm_source=wa');
  queue('m3', 'a@g.us', 10, 'Known https://jobs.lever.co/acme/known and a store link https://play.google.com/store/apps/x');
  queue('m4', 'b@g.us', 5, 'LinkedIn https://il.linkedin.com/jobs/view/backend-at-x-4400000001?refId=1');
  queue('m5', 'a@g.us', 60 * 24 * 10, 'Too old https://jobs.lever.co/acme/old');
  queue('m6', 'a@g.us', 1, 'no link, just chatter');

  const state = inspectWhatsAppBacklog({ config, store, now });
  assert.equal(state.pendingMessages, 5);
  assert.equal(state.newJobs, 2);
  assert.equal(state.waitedMinutes, 90);
  assert.deepEqual(shouldProcess(state), { run: false, reason: 'waiting_for_more' });
  assert.equal(store.countJobs(), 1, 'inspection records nothing');
  assert.equal(store.getMessageState('m1').status, 'pending', 'inspection marks nothing');
  store.close();
});
