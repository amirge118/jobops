import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { formatJobNotification, queueJobNotifications, sendPendingNotifications } from '../scripts/jobs/notifications.mjs';
import { ownJidOf } from '../scripts/jobs/whatsapp-collector.mjs';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-notify-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

const config = { notifications: { whatsapp: { enabled: true, minScore: 4, dashboardUrl: 'http://127.0.0.1:4177/decisions' } } };
const job = (jobKey, score) => ({ jobKey, score, company: 'Acme', title: 'Backend Engineer', applyUrl: `https://acme.example/${jobKey}` });

test('only jobs at or above the threshold are queued, and each job only once', () => {
  const store = newStore();
  assert.equal(queueJobNotifications({ store, jobs: [job('a', 4.2), job('b', 3.9), job('c', 4)], config }), 2);
  assert.equal(queueJobNotifications({ store, jobs: [job('a', 4.2)], config }), 0);
  assert.deepEqual(store.listPendingNotifications().map((item) => item.jobKey), ['a', 'c']);
  assert.equal(queueJobNotifications({ store, jobs: [job('d', 5)], config: { notifications: { whatsapp: { enabled: false } } } }), 0);
  store.close();
});

test('the message names the score, company, role, posting and decisions page', () => {
  const text = formatJobNotification(job('a', 4.25), config.notifications.whatsapp);
  assert.match(text, /\(4\.3\): Acme — Backend Engineer/);
  assert.match(text, /https:\/\/acme\.example\/a/);
  assert.match(text, /http:\/\/127\.0\.0\.1:4177\/decisions/);
});

test('the collector sends pending notifications to its own chat and retries failures', async () => {
  const store = newStore();
  queueJobNotifications({ store, jobs: [job('a', 4.5), job('b', 4.5)], config });
  const sent = [];
  const sock = { async sendMessage(jid, content) {
    if (content.text.includes('/b')) throw new Error('offline');
    sent.push([jid, content.text]);
  } };
  const result = await sendPendingNotifications({ store, sock, ownJid: '972500000000@s.whatsapp.net' });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.equal(sent[0][0], '972500000000@s.whatsapp.net');
  // The failed one stays pending; the sent one is never sent again.
  assert.deepEqual(store.listPendingNotifications().map((item) => item.jobKey), ['b']);
  // Stale notifications (older than a day) are dropped rather than sent late.
  assert.deepEqual(store.listPendingNotifications({ now: Date.now() + 25 * 60 * 60 * 1000 }), []);
  store.close();
});

test('nothing is sent without the own chat id, which comes from the connected account', async () => {
  assert.equal(ownJidOf({ user: { id: '972500000000:12@s.whatsapp.net' } }), '972500000000@s.whatsapp.net');
  assert.equal(ownJidOf({}), null);
  const store = newStore();
  queueJobNotifications({ store, jobs: [job('a', 4.5)], config });
  assert.deepEqual(await sendPendingNotifications({ store, sock: {}, ownJid: null }), { sent: 0, failed: 0 });
  store.close();
});

test('a LinkedIn posting keeps the posting time estimated at its first sighting', () => {
  const store = newStore();
  store.recordLinkedInPosting({ linkedinId: '1', jobKey: 'k', listedAt: '2026-10-03', postedAgeMs: 3 * 3600e3, seenAt: 10 * 3600e3 });
  store.recordLinkedInPosting({ linkedinId: '1', jobKey: 'k', listedAt: '2026-10-03', postedAgeMs: 24 * 3600e3, seenAt: 30 * 3600e3 });
  assert.equal(store.linkedinPostedAt('1'), 7 * 3600e3);
  store.close();
});
