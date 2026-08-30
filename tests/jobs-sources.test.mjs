import assert from 'node:assert/strict';
import test from 'node:test';

import { scanAts } from '../scripts/jobs/sources/ats.mjs';
import {
  diagnoseUnavailableHistory,
  markConfiguredGroupsRead,
  queueIncomingMessages,
  verifyConfiguredGroups,
} from '../scripts/jobs/sources/whatsapp.mjs';
import {
  createWhatsAppSocketOptions,
  decideHistoryWait,
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

test('an existing WhatsApp session with no history anchor reports a relink failure', () => {
  const groups = [{
    name: 'Group A', found: true, messages: 0, candidates: 0, error: null,
    coverage: { status: 'unknown', delivered: 0 },
  }];

  const diagnosed = diagnoseUnavailableHistory(
    groups,
    { historyEvents: 0, upsertEvents: 0 },
    { processedHistoryMessages: 10 },
  );

  assert.equal(diagnosed[0].coverage.status, 'failed');
  assert.equal(diagnosed[0].coverage.reason, 'stale-session-no-anchor');
  assert.match(diagnosed[0].error, /session חדש/);
  assert.deepEqual(
    diagnoseUnavailableHistory(groups, { historyEvents: 1 }, { processedHistoryMessages: 10 }),
    groups,
  );
});

test('WhatsApp read action uses collected keys, live chat state, and stored checkpoint fallbacks', async () => {
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
    sources: { whatsapp: { groups: [
      { name: 'Group A', jid: 'a@g.us' },
      { name: 'Group B', jid: 'b@g.us' },
      { name: 'Group C', jid: 'c@g.us' },
    ] } },
  };
  const store = {
    getCheckpoint(key) {
      return key === 'whatsapp:c@g.us' ? 300_999 : null;
    },
    listWhatsAppMessageKeys() { return []; },
  };

  const result = await markConfiguredGroupsRead(config, sock, { store });

  assert.equal(result.every((group) => group.marked), true);
  assert.deepEqual(readCalls[0], [message.key]);
  assert.deepEqual(modifyCalls[0], {
    jid: 'b@g.us',
    modification: { markRead: true, lastMessages: { lastMessageTimestamp: 200 } },
  });
  assert.deepEqual(modifyCalls[1], {
    jid: 'c@g.us',
    modification: { markRead: true, lastMessages: { lastMessageTimestamp: 300 } },
  });
  assert.equal(result[2].anchor, 'stored-checkpoint');
});

test('WhatsApp read action falls back to persisted message IDs when app state is unavailable', async () => {
  const receiptCalls = [];
  const sock = {
    historyStore: new Map(),
    chatStore: new Map(),
    async chatModify() { throw new Error('app state key is unavailable'); },
    async readMessages(keys) { receiptCalls.push(keys); },
  };
  const config = {
    sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'a@g.us' }] } },
  };
  const keys = Array.from({ length: 101 }, (_, index) => ({
    id: `message-${index}`,
    remoteJid: 'a@g.us',
    fromMe: false,
  }));
  const store = {
    getCheckpoint: () => 500_000,
    listWhatsAppMessageKeys: () => keys,
  };

  const [result] = await markConfiguredGroupsRead(config, sock, { store });

  assert.equal(result.marked, true);
  assert.equal(result.method, 'stored-message-receipts');
  assert.equal(result.messages, 101);
  assert.equal(receiptCalls.length, 2);
  assert.equal(receiptCalls[0].length, 100);
  assert.equal(receiptCalls[1].length, 1);
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

test('WhatsApp connection waits for every announced history download to settle', () => {
  assert.equal(decideHistoryWait({
    elapsedMs: 10_000, historyEvents: 0, historyNotifications: 0, lastActivityAgoMs: 10_000,
    initialWaitMs: 30_000, maxWaitMs: 120_000, quietMs: 3_000,
  }), 'wait');
  assert.equal(decideHistoryWait({
    elapsedMs: 31_000, historyEvents: 0, historyNotifications: 0, lastActivityAgoMs: 31_000,
    initialWaitMs: 30_000, maxWaitMs: 120_000, quietMs: 3_000,
  }), 'empty');
  assert.equal(decideHistoryWait({
    elapsedMs: 40_000, historyEvents: 2, historyNotifications: 3, lastActivityAgoMs: 5_000,
    initialWaitMs: 30_000, maxWaitMs: 120_000, quietMs: 3_000,
  }), 'wait');
  assert.equal(decideHistoryWait({
    elapsedMs: 45_000, historyEvents: 3, historyNotifications: 3, lastActivityAgoMs: 3_500,
    initialWaitMs: 30_000, maxWaitMs: 120_000, quietMs: 3_000,
  }), 'settled');
  assert.equal(decideHistoryWait({
    elapsedMs: 120_000, historyEvents: 1, historyNotifications: 3, lastActivityAgoMs: 30_000,
    initialWaitMs: 30_000, maxWaitMs: 120_000, quietMs: 3_000,
  }), 'timeout');
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
    groupHistoryDiagnostics: new Map(),
    async fetchMessageHistory() { fetchCalls += 1; },
  };

  const messages = await fetchGroupMessagesSince(sock, { jid: 'a@g.us', name: 'Group A' }, 0);

  assert.deepEqual(messages, []);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(sock.groupHistoryDiagnostics.get('a@g.us'), {
    status: 'unknown',
    requestedFrom: 0,
    oldestAt: null,
    newestAt: null,
    delivered: 0,
    collected: 0,
    batches: 0,
  });
});

test('WhatsApp history coverage is complete only after raw history reaches the requested boundary', async () => {
  const older = { key: { id: 'older', remoteJid: 'a@g.us' }, messageTimestamp: 90 };
  const newer = { key: { id: 'newer', remoteJid: 'a@g.us' }, messageTimestamp: 110 };
  const sock = {
    historyStore: new Map([['a@g.us', new Map([['older', older], ['newer', newer]])]]),
    groupHistoryDiagnostics: new Map(),
    async fetchMessageHistory() { throw new Error('history should already cover the boundary'); },
  };

  const messages = await fetchGroupMessagesSince(sock, { jid: 'a@g.us', name: 'Group A' }, 100_000);

  assert.deepEqual(messages.map((message) => message.key.id), ['newer']);
  assert.deepEqual(sock.groupHistoryDiagnostics.get('a@g.us'), {
    status: 'complete',
    requestedFrom: 100_000,
    oldestAt: 90_000,
    newestAt: 110_000,
    delivered: 1,
    collected: 2,
    batches: 0,
  });
});
