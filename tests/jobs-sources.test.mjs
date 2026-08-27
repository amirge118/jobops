import assert from 'node:assert/strict';
import test from 'node:test';

import { scanAts } from '../scripts/jobs/sources/ats.mjs';
import {
  markConfiguredGroupsRead,
  queueIncomingMessages,
  verifyConfiguredGroups,
} from '../scripts/jobs/sources/whatsapp.mjs';
import {
  createWhatsAppSocketOptions,
  shouldRetryWhatsAppConnection,
} from '../scripts/jobs/sources/whatsapp-client.mjs';
import { fetchGroupMessagesSince } from '../scripts/jobs/sources/whatsapp-history.mjs';

test('ATS source feeds portal offers into the shared store', async () => {
  const sightings = [];
  const store = {
    recordSighting(input) {
      sightings.push(input);
      return { jobKey: 'job-1', canonicalUrl: input.url, isNew: true };
    },
  };
  const runScan = async (args) => {
    assert.deepEqual(args, ['--dry-run', '--quiet', '--ignore-history', '--max-age=48']);
    return {
      offers: [{
        url: 'https://example.com/jobs/1', company: 'Example', title: 'Backend Engineer', source: 'greenhouse-api',
      }],
      stats: { newOffers: 1 },
      errors: [],
    };
  };

  const result = await scanAts({ store, lookbackHours: 48, runScan });

  assert.equal(result.source, 'ats');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'ATS: greenhouse-api');
  assert.equal(sightings[0].company, 'Example');
});

test('WhatsApp group verification checks each configured JID', async () => {
  const config = {
    sources: {
      whatsapp: {
        groups: [
          { name: 'Group A', jid: 'a@g.us' },
          { name: 'Group B', jid: 'b@g.us' },
        ],
      },
    },
  };
  const sock = {
    async groupFetchAllParticipating() {
      return {
        'a@g.us': { subject: 'Group A', participants: [{}, {}] },
        'b@g.us': { subject: 'Group B live', participants: [{}] },
      };
    },
  };

  const result = await verifyConfiguredGroups(config, sock);

  assert.deepEqual(result.map((group) => group.found), [true, true]);
  assert.equal(result[1].liveName, 'Group B live');
});

test('WhatsApp read action uses collected message keys and chat timestamp fallback', async () => {
  const readCalls = [];
  const modifyCalls = [];
  const message = {
    key: { id: 'message-a', remoteJid: 'a@g.us', participant: 'person@s.whatsapp.net', fromMe: false },
    messageTimestamp: 100,
  };
  const sock = {
    historyStore: new Map([['a@g.us', new Map([['message-a', message]])]]),
    chatStore: new Map([['b@g.us', { id: 'b@g.us', unreadCount: 3, lastMessageRecvTimestamp: 200 }]]),
    async readMessages(keys) { readCalls.push(keys); },
    async chatModify(modification, jid) { modifyCalls.push({ modification, jid }); },
  };
  const config = {
    sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'a@g.us' }, { name: 'Group B', jid: 'b@g.us' }] } },
  };

  const result = await markConfiguredGroupsRead(config, sock);

  assert.equal(result.every((group) => group.marked), true);
  assert.deepEqual(readCalls[0], [message.key]);
  assert.deepEqual(modifyCalls[0], {
    jid: 'b@g.us',
    modification: { markRead: true, lastMessages: { lastMessageTimestamp: 200 } },
  });
});

test('WhatsApp socket requests history as a supported web client', () => {
  const options = createWhatsAppSocketOptions({ auth: { creds: {}, keys: {} }, logger: {} });

  assert.equal(options.browser[0], 'Ubuntu');
  assert.equal(options.browser[1], 'Chrome');
  assert.equal(options.syncFullHistory, true);
  assert.equal(options.markOnlineOnConnect, false);
});

test('WhatsApp retries transient disconnects but not logout or replacement', () => {
  assert.equal(shouldRetryWhatsAppConnection(428), true);
  assert.equal(shouldRetryWhatsAppConnection(408), true);
  assert.equal(shouldRetryWhatsAppConnection(503), true);
  assert.equal(shouldRetryWhatsAppConnection(401), false);
  assert.equal(shouldRetryWhatsAppConnection(440), false);
});

test('WhatsApp ingress queues only bounded text from configured groups', () => {
  const queued = [];
  const store = {
    queueWhatsAppMessage(message) {
      queued.push(message);
      return true;
    },
  };
  const messages = [
    {
      key: { id: 'allowed', remoteJid: 'a@g.us', fromMe: false },
      messageTimestamp: 100,
      message: { ephemeralMessage: { message: { conversation: 'Backend role https://example.com/job/1' } } },
    },
    {
      key: { id: 'other-group', remoteJid: 'b@g.us', fromMe: false },
      messageTimestamp: 101,
      message: { conversation: 'https://example.com/job/2' },
    },
    {
      key: { id: 'too-large', remoteJid: 'a@g.us', fromMe: false },
      messageTimestamp: 102,
      message: { conversation: 'x'.repeat(40_000) },
    },
  ];

  const result = queueIncomingMessages({
    messages,
    configuredGroupJids: new Set(['a@g.us']),
    store,
    sinceMs: 0,
  });

  assert.deepEqual(result, { queued: 1, duplicates: 0, ignored: 1, rejected: 1 });
  assert.deepEqual(queued, [{
    messageId: 'allowed',
    groupJid: 'a@g.us',
    timestamp: 100_000,
    text: 'Backend role https://example.com/job/1',
  }]);
});

test('WhatsApp history fetch does not use a synthetic message anchor', async () => {
  let fetchCalls = 0;
  const sock = {
    historyStore: new Map(),
    async fetchMessageHistory() { fetchCalls += 1; },
  };

  const messages = await fetchGroupMessagesSince(sock, { jid: 'a@g.us', name: 'Group A' }, 0);

  assert.deepEqual(messages, []);
  assert.equal(fetchCalls, 0);
});
