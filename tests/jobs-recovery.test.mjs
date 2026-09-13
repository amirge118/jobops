import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchGroupMessagesSince, normalizeWhatsAppAnchor } from '../scripts/jobs/sources/whatsapp-history.mjs';
import { scanWhatsApp, queueIncomingMessages } from '../scripts/jobs/sources/whatsapp.mjs';
import { scanAts } from '../scripts/jobs/sources/ats.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import Database from 'better-sqlite3';
import { evaluateCandidates } from '../scripts/jobs.mjs';

const group = { jid: 'group@g.us', name: 'Test group' };
const message = (id, timestamp, text = 'https://example.com/jobs/1') => ({ key: { id, remoteJid: group.jid, fromMe: false }, messageTimestamp: timestamp, message: { conversation: text } });
function tempStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-recovery-'));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const immediate = { waitMs: 0, anchorWaitMs: 0 };

test('an empty socket recovers backwards from a genuine saved anchor, without counting it as a delivered message', async () => {
  const anchor = message('saved', 200);
  let calls = 0;
  const sock = { historyStore: new Map(), async fetchMessageHistory(count, key, timestamp) {
    calls += 1; assert.equal(count, 50); assert.deepEqual(key, anchor.key); assert.equal(timestamp, 200);
    sock.historyStore.set(group.jid, new Map([['boundary', message('boundary', 90)], ['job', message('job', 150)]]));
  } };
  const result = await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, store: { getWhatsAppAnchor: () => anchor } });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((item) => item.key.id), ['job']);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).anchorSource, 'stored');
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).status, 'complete');
});

test('an anchor older than the requested window cannot manufacture recent coverage', async () => {
  let calls = 0;
  const sock = { historyStore: new Map(), fetchMessageHistory: async () => { calls += 1; } };
  const result = await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, store: { getWhatsAppAnchor: () => message('old', 50) } });
  assert.equal(result.length, 0); assert.equal(calls, 0);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'anchor_too_old');
  assert.notEqual(sock.groupHistoryDiagnostics.get(group.jid).status, 'complete');
});

test('a late current-chat message can bootstrap the missing group without fabricated IDs', async () => {
  let now = 0;
  let calls = 0;
  const sock = { historyStore: new Map(), chatStore: new Map(), async fetchMessageHistory(count, key) {
    calls += 1; assert.equal(key.id, 'head');
    sock.historyStore.set(group.jid, new Map([['old', message('old', 90)], ['in-window', message('in-window', 160)]]));
  } };
  const result = await fetchGroupMessagesSince(sock, group, 100_000, { untilMs: 180_000, anchorWaitMs: 1000, waitMs: 0, now: () => now,
    sleep: async (ms) => { now += ms; sock.chatStore.set(group.jid, { messages: [{ message: message('head', 200) }] }); },
  });
  assert.equal(calls, 1); assert.equal(result.some((item) => item.key.id === 'in-window'), true);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).status, 'complete');
});

test('missing and cross-group anchors never issue a history request', async () => {
  let calls = 0;
  const sock = { historyStore: new Map(), fetchMessageHistory: async () => { calls += 1; } };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000,
    store: { getWhatsAppAnchor: () => ({ ...message('x', 200), key: { id: 'x', remoteJid: 'other@g.us', fromMe: false } }) },
  });
  assert.equal(calls, 0);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'missing_anchor');
});

test('accepted history requests with no delivered batch stay incomplete', async () => {
  let calls = 0;
  const sock = { historyStore: new Map(), fetchMessageHistory: async () => { calls += 1; return 'private-request-id'; } };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, store: { getWhatsAppAnchor: () => message('saved', 200) } });
  assert.equal(calls, 1);
  const diagnostic = sock.groupHistoryDiagnostics.get(group.jid);
  assert.equal(diagnostic.reason, 'history_no_response');
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-request-id|saved/);
});

test('history deadlines also bound a request promise that never settles', { timeout: 1000 }, async () => {
  const sock = { historyStore: new Map(), fetchMessageHistory: async () => new Promise(() => {}) };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, requestTimeoutMs: 5, store: { getWhatsAppAnchor: () => message('saved', 200) } });
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'history_request_timeout');
});

test('saved anchors contain metadata only, stay group-scoped and do not go backwards', (context) => {
  const store = tempStore(context);
  const config = { configuredGroupJids: new Set([group.jid]), store, sinceMs: 0 };
  queueIncomingMessages({ ...config, messages: [message('latest', 200, 'private-body')] });
  queueIncomingMessages({ ...config, messages: [message('old', 100)] });
  const anchor = store.getWhatsAppAnchor(group.jid);
  assert.equal(anchor.key.id, 'latest');
  assert.doesNotMatch(JSON.stringify(anchor), /private-body|conversation/);
  assert.equal(store.getWhatsAppAnchor('other@g.us'), null);
});

test('anchor migration is additive, survives reopening and uses its primary-key lookup', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-anchor-migration-'));
  const dbPath = path.join(dir, 'jobs.db');
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = createJobStore(dbPath);
  const job = store.recordSighting({ url: 'https://example.com/jobs/existing' });
  store.close();
  const legacy = new Database(dbPath);
  legacy.exec('DROP TABLE whatsapp_anchors'); // Synthetic legacy database only.
  legacy.close();
  store = createJobStore(dbPath);
  assert.ok(store.getJob(job.jobKey));
  store.saveWhatsAppAnchor(group.jid, message('saved', 200, 'private-body'));
  store.close();
  store = createJobStore(dbPath);
  assert.equal(store.getWhatsAppAnchor(group.jid).key.id, 'saved');
  store.close();
  const db = new Database(dbPath, { readonly: true });
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT message_key_json, timestamp FROM whatsapp_anchors WHERE group_jid = ?').all(group.jid);
    assert.match(plan[0].detail, /USING INDEX sqlite_autoindex_whatsapp_anchors/);
    assert.doesNotMatch(db.prepare('SELECT message_key_json FROM whatsapp_anchors').get().message_key_json, /private-body/);
  } finally { db.close(); }
});

test('an earlier scoring decision must not hide a later retryable page failure', async (context) => {
  const store = tempStore(context);
  const candidate = { ...store.recordSighting({ url: 'https://example.com/jobs/retry' }), url: 'https://example.com/jobs/retry' };
  store.saveEvaluation(candidate.jobKey, { suitable: true, score: 4.5, fitLabel: 'match', company: 'Example', title: 'Engineer',
    summary: 'test', decisionReason: 'test', applyUrl: candidate.url, contentHash: 'previous', profileHash: 'profile',
    criteriaVersion: 'v1', evaluatedAt: Date.now(), activeStatus: 'active' });
  store.markEvaluationFailure(candidate.jobKey, { code: 'page_uncertain', reason: 'retry needed' });
  let fetched = 0;
  const outcomes = await evaluateCandidates({ candidates: [candidate], config: { decision: { criteriaVersion: 'v1' } }, store,
    fetcher: { fetch: async () => { fetched += 1; return { status: 'uncertain', code: 'page_uncertain' }; } },
    scorer: { profileHash: 'profile', scoreBatchSettled: async () => {} },
  });
  assert.equal(fetched, 1);
  assert.equal(outcomes.get(candidate.jobKey).status, 'failed');
});

test('a scan with zero delivered messages never marks old stored messages or chat state as read', async (context) => {
  const store = tempStore(context);
  store.queueWhatsAppMessage({ messageId: 'old', groupJid: group.jid, timestamp: 100_000, text: 'private-old' });
  store.markMessageDone({ messageId: 'old', groupJid: group.jid, timestamp: 100_000 });
  let receipts = 0;
  const sock = { historyStore: new Map(), groupFetchAllParticipating: async () => ({ [group.jid]: {} }),
    readMessages: async () => { receipts += 1; }, chatModify: async () => { receipts += 1; } };
  const result = await scanWhatsApp({ config: { sources: { whatsapp: { enabled: true, authAbsPath: '/unused', markRead: true, groups: [group] } } },
    store, sinceMs: 100_000, untilMs: 180_000, connect: async () => sock, disconnect: async () => {}, historyOptions: immediate });
  assert.equal(receipts, 0);
  assert.equal(result.groups[0].read.status, 'skipped');
  assert.equal(result.groups[0].read.messages, 0);
});

test('ATS distinguishes first-seen candidates from previously known ones', async () => {
  const result = await scanAts({ store: { recordSighting: ({ url }) => ({ jobKey: url, canonicalUrl: url, isNew: url.endsWith('/new') }) },
    runScan: async () => ({ offers: [{ url: 'https://example.com/new' }, { url: 'https://example.com/known' }], stats: {}, errors: [] }) });
  assert.deepEqual(result.discovery, { found: 2, new: 1, known: 1 });
});

test('duplicate ATS sightings in one run retain their first-seen classification', async (context) => {
  const store = tempStore(context);
  const result = await scanAts({ store, runScan: async () => ({ offers: [
    { url: 'https://example.com/jobs/new?utm_source=a' }, { url: 'https://example.com/jobs/new?utm_source=b' },
  ], stats: {}, errors: [] }) });
  assert.deepEqual(result.discovery, { found: 1, new: 1, known: 0 });
});

test('a fresher chat head is preferred to an older buffer, without using the old buffer to prove coverage', async () => {
  const calls = [];
  const sock = { historyStore: new Map([[group.jid, new Map([['old', message('old', 90)]])]]),
    chatStore: new Map([[group.jid, { messages: [{ message: message('head', 200) }] }]]),
    async fetchMessageHistory(_count, key) {
      calls.push(key.id);
      if (calls.length === 1) sock.historyStore.get(group.jid).set('middle', message('middle', 150));
    },
  };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000 });
  assert.deepEqual(calls, ['head', 'middle']);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).status, 'partial');
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'history_no_response');
});

test('a live upsert is not evidence that a history request delivered its batch', async () => {
  const sock = { historyStore: new Map(), historyBatches: new Map(), async fetchMessageHistory() {
    sock.historyStore.set(group.jid, new Map([['live', message('live', 200)]]));
  } };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, store: { getWhatsAppAnchor: () => message('saved', 200) } });
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'history_no_response');
});

test('anchor wait diagnostics exclude later time spent waiting for a history response', async () => {
  let now = 0;
  const sock = { historyStore: new Map(), chatStore: new Map(), fetchMessageHistory: async () => {} };
  await fetchGroupMessagesSince(sock, group, 100_000, { untilMs: 180_000, anchorWaitMs: 1000, waitMs: 1000, now: () => now,
    sleep: async (ms) => { now += ms; sock.chatStore.set(group.jid, { messages: [{ message: message('head', 200) }] }); },
  });
  assert.equal(now, 1500);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).anchorWaitMs, 500);
});

test('malformed metadata cannot be persisted as a cursor', (context) => {
  const store = tempStore(context);
  for (const item of [
    { ...message('x', 100), key: { id: 'x', remoteJid: group.jid } },
    { ...message('x', 100), key: { id: 'x'.repeat(257), remoteJid: group.jid, fromMe: false } },
    message('x', -1), message('x', 10 ** 15),
    { ...message('x', 100), key: { id: 'x', remoteJid: 'other@g.us', fromMe: false } },
  ]) {
    assert.equal(normalizeWhatsAppAnchor(item, group.jid), null);
    assert.equal(store.saveWhatsAppAnchor(group.jid, item), false);
  }
  assert.equal(store.getWhatsAppAnchor(group.jid), null);
});

test('a saved anchor inside the window does not claim coverage of newer messages', async () => {
  const sock = { historyStore: new Map(), async fetchMessageHistory() {
    sock.historyStore.set(group.jid, new Map([['old', message('old', 90)], ['job', message('job', 130)]]));
  } };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, store: { getWhatsAppAnchor: () => message('saved', 150) } });
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).status, 'partial');
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'newer_messages_unverified');
});

test('history pagination is capped and does not retry the same cursor', async () => {
  let calls = 0;
  const sock = { historyStore: new Map(), async fetchMessageHistory() {
    calls += 1;
    if (!sock.historyStore.has(group.jid)) sock.historyStore.set(group.jid, new Map());
    sock.historyStore.get(group.jid).set(`batch-${calls}`, message(`batch-${calls}`, 200 - calls));
  } };
  await fetchGroupMessagesSince(sock, group, 100_000, { ...immediate, untilMs: 180_000, maxBatches: 2, store: { getWhatsAppAnchor: () => message('saved', 200) } });
  assert.equal(calls, 2);
  assert.equal(sock.groupHistoryDiagnostics.get(group.jid).reason, 'history_batch_limit');
});

test('scan receipts exclude failed extraction, out-of-window, other-group and outgoing messages', async (context) => {
  const store = tempStore(context);
  const incoming = [message('old', 90), message('ok', 150), message('bad', 160, 'https://'), message('future', 200),
    { ...message('outgoing', 155), key: { ...message('outgoing', 155).key, fromMe: true } },
    { ...message('other', 155), key: { id: 'other', remoteJid: 'other@g.us', fromMe: false } }];
  // A failed persistent extraction is still retryable and must not be marked read.
  const recordSighting = store.recordSighting;
  store.recordSighting = (input) => { if (input.url === 'https://bad.invalid/') throw new Error('extraction failed'); return recordSighting(input); };
  incoming[2].message.conversation = 'https://bad.invalid/';
  const keys = [];
  const sock = { historyStore: new Map([[group.jid, new Map(incoming.map((item) => [item.key.id, item]))]]),
    groupFetchAllParticipating: async () => ({ [group.jid]: {} }), readMessages: async (batch) => keys.push(...batch),
    chatModify: async () => { throw new Error('scan must never mark a whole chat'); } };
  const result = await scanWhatsApp({ config: { sources: { whatsapp: { enabled: true, authAbsPath: '/unused', markRead: true, groups: [group] } } },
    store, sinceMs: 100_000, untilMs: 180_000, connect: async () => sock, disconnect: async () => {}, historyOptions: immediate });
  assert.deepEqual(keys.map((key) => key.id), ['ok']);
  assert.equal(result.groups[0].read.status, 'sent');
  assert.equal(result.groups[0].failedMessages, 1);
  assert.equal(store.getMessageState('bad').status, 'failed');
});

test('receipt failure preserves the scan result and the count of acknowledged batches', async (context) => {
  const store = tempStore(context);
  const incoming = Array.from({ length: 101 }, (_, index) => message(`msg-${index}`, 150, 'no links'));
  let calls = 0;
  let disconnected = false;
  const sock = { historyStore: new Map([[group.jid, new Map(incoming.map((item) => [item.key.id, item]))]]),
    groupFetchAllParticipating: async () => ({ [group.jid]: {} }), fetchMessageHistory: async () => {},
    readMessages: async (batch) => { calls += 1; assert.equal(batch.length, calls === 1 ? 100 : 1); if (calls === 2) throw new Error('private transport error'); } };
  const result = await scanWhatsApp({ config: { sources: { whatsapp: { enabled: true, authAbsPath: '/unused', markRead: true, groups: [group] } } },
    store, sinceMs: 100_000, untilMs: 180_000, connect: async () => sock, disconnect: async () => { disconnected = true; }, historyOptions: immediate });
  assert.equal(result.groups[0].messages, 101);
  assert.equal(result.groups[0].read.status, 'failed');
  assert.equal(result.groups[0].read.messages, 100);
  assert.doesNotMatch(result.groups[0].read.error, /private transport/);
  assert.equal(disconnected, true);
});

test('a stalled read receipt has a deadline and does not prevent disconnect', { timeout: 1000 }, async (context) => {
  const store = tempStore(context);
  let disconnected = false;
  const sock = { historyStore: new Map([[group.jid, new Map([['job', message('job', 150)]])]]),
    groupFetchAllParticipating: async () => ({ [group.jid]: {} }), fetchMessageHistory: async () => {},
    readMessages: async () => new Promise(() => {}) };
  const result = await scanWhatsApp({ config: { sources: { whatsapp: { enabled: true, authAbsPath: '/unused', markRead: true, groups: [group] } } },
    store, sinceMs: 100_000, untilMs: 180_000, connect: async () => sock, disconnect: async () => { disconnected = true; },
    historyOptions: immediate, readTimeoutMs: 5 });
  assert.equal(result.groups[0].read.status, 'failed');
  assert.equal(result.groups[0].read.messages, 0);
  assert.equal(result.groups[0].messages, 1);
  assert.equal(disconnected, true);
});
