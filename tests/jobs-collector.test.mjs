import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Boom } from '@hapi/boom';

import { describeFailure } from '../scripts/jobs/diagnostics.mjs';
import { renderLaunchAgent } from '../scripts/jobs/collector-service.mjs';
import { acquireSingleInstance } from '../scripts/jobs/single-instance.mjs';
import { scanWhatsApp } from '../scripts/jobs/sources/whatsapp.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { hasContinuityGap, processNextHistoryRequest, reconnectDelay, runWhatsAppCollector } from '../scripts/jobs/whatsapp-collector.mjs';

const group = { name: 'Group A', jid: 'group-a@g.us' };
const configFor = (dir) => ({
  dataDir: dir,
  sources: { whatsapp: { enabled: true, authAbsPath: path.join(dir, 'auth'), markRead: true, groups: [group] } },
});

function temporary(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-collector-'));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('single-instance lock rejects a live owner and recovers a stale lock', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-lock-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, 'collector.lock');
  const first = acquireSingleInstance(lockPath, { pid: 111, probe: (pid) => pid === 111 ? 'alive' : 'dead' });
  assert.throws(() => acquireSingleInstance(lockPath, { pid: 222, probe: () => 'alive' }), (error) => error.code === 'JOBOPS_COLLECTOR_ALREADY_RUNNING');
  first.release();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 333, startedAt: 1 }));
  const recovered = acquireSingleInstance(lockPath, { pid: 444, probe: () => 'dead' });
  recovered.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('collector diagnostics classify session failures without persisting raw material', () => {
  const result = describeFailure(new Error('Bad MAC while decrypting secret-message-body'));
  assert.equal(result.code, 'decrypt_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret-message-body|Bad MAC/);
  assert.equal(describeFailure(new Error('connection replaced status 440')).code, 'connection_replaced');
  assert.equal(describeFailure(new Error('collector already running; lock already held')).code, 'collector_already_running');
});

test('reconnect delay is exponential, bounded and jittered deterministically', () => {
  assert.equal(reconnectDelay(1, { baseMs: 1_000, maxMs: 10_000, random: () => 0.5 }), 1_000);
  assert.equal(reconnectDelay(4, { baseMs: 1_000, maxMs: 5_000, random: () => 0.5 }), 5_000);
  assert.equal(reconnectDelay(1, { baseMs: 1_000, maxMs: 10_000, random: () => 0 }), 800);
});

test('collector treats a long heartbeat pause as an unproven coverage gap', () => {
  assert.equal(hasContinuityGap(1_000, 20_000, 20_000), false);
  assert.equal(hasContinuityGap(1_000, 21_001, 20_000), true);
});

test('launch agent starts one background collector without writing QR to output', () => {
  const plist = renderLaunchAgent({ nodePath: '/opt/node & tools/node', rootDir: '/tmp/jobops <local>' });
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, /JOBOPS_HIDE_QR/);
  assert.doesNotMatch(plist, /Standard(?:Out|Error)Path/);
  assert.match(plist, /\/opt\/node &amp; tools\/node/);
  assert.match(plist, /\/tmp\/jobops &lt;local&gt;/);
});

test('collector durably queues configured messages, sends receipts and records a safe timeline', async (context) => {
  const { dir, store } = temporary(context);
  const message = { key: { id: 'message-1', remoteJid: group.jid, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1_000), message: { conversation: 'private text https://example.com/jobs/1' } };
  const receiptIds = [];
  const sock = {
    groupFetchAllParticipating: async () => ({ [group.jid]: { subject: group.name, participants: [{ id: 'private-user' }] } }),
    readMessages: async (keys) => receiptIds.push(...keys.map((key) => key.id)),
  };
  const connect = async (_authPath, options) => {
    options.onMessages([message], sock);
    setImmediate(() => options.onConnectionUpdate({ connection: 'close', lastDisconnect: { error: new Boom('replaced', { statusCode: 440 }) } }, sock));
    return sock;
  };

  const result = await runWhatsAppCollector({ config: configFor(dir), store, connect, disconnect: async () => {}, registerSignals: false });
  assert.equal(result.status, 'failed');
  assert.deepEqual(receiptIds, ['message-1']);
  assert.equal(store.getMessageState('message-1').status, 'pending');
  const diagnostic = store.getCollectorRun(result.id);
  assert.equal(diagnostic.messages_received, 1);
  assert.equal(diagnostic.messages_queued, 1);
  assert.equal(diagnostic.receipts_sent, 1);
  assert.equal(diagnostic.events.some((event) => event.stage === 'message-ingress'), true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private text|private-user|group-a@g\.us/);
});

test('scan consumes the collector inbox without opening another WhatsApp session', async (context) => {
  const { dir, store } = temporary(context);
  const collectorId = Number(store.startCollectorRun({ ownerPid: process.pid, startedAt: 1_000, groupsExpected: 1 }));
  store.updateCollectorRun(collectorId, { status: 'connected', stage: 'connected', connectedAt: 1_000, groupsFound: 1 });
  store.recordCollectorEvent(collectorId, { stage: 'group-verification', status: 'complete', details: { groups: [{ name: group.name, found: true, liveName: group.name, participants: 10 }] } });
  store.queueWhatsAppMessage({ messageId: 'queued-1', groupJid: group.jid, timestamp: 2_000, text: 'https://example.com/jobs/collector' });
  let connected = false;

  const result = await scanWhatsApp({ config: configFor(dir), store, sinceMs: 1_500, untilMs: 3_000,
    connect: async () => { connected = true; throw new Error('must not connect'); } });

  assert.equal(connected, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.groups[0].coverage.status, 'complete');
  assert.equal(result.groups[0].read.status, 'skipped');
  assert.equal(result.groups[0].read.marked, false);
  assert.equal(store.getMessageState('queued-1').status, 'done');
});

test('collector executes one durable history request on its existing socket', async (context) => {
  const { dir, store } = temporary(context);
  const request = store.requestWhatsAppHistory({ fromTs: 1_000, toTs: 5_000, groupsTotal: 1 });
  const historical = {
    key: { id: 'history-1', remoteJid: group.jid, fromMe: false },
    messageTimestamp: 3,
    message: { conversation: 'https://example.com/jobs/history-1' },
  };
  const sock = { groupHistoryDiagnostics: new Map() };

  const result = await processNextHistoryRequest({
    config: configFor(dir), store, sock, collectorRunId: 99,
    fetchHistory: async (_sock, requestedGroup, sinceMs, options) => {
      assert.equal(requestedGroup.jid, group.jid);
      assert.equal(sinceMs, 1_000);
      assert.equal(options.untilMs, 5_000);
      sock.groupHistoryDiagnostics.set(group.jid, {
        status: 'complete', requestedFrom: 1_000, requestedUntil: 5_000,
        oldestAt: 1_000, newestAt: 5_000, delivered: 1, collected: 1, batches: 1,
      });
      return [historical];
    },
    recordEvent: () => {},
  });

  assert.equal(result.id, request.request.id);
  assert.equal(result.status, 'complete');
  assert.equal(store.getMessageState('history-1').status, 'pending');
  assert.equal(store.getLatestWhatsAppHistoryRequest().messagesQueued, 1);
});

test('collector history request keeps successful group evidence when another group fails', async (context) => {
  const { dir, store } = temporary(context);
  const second = { name: 'Group B', jid: 'group-b@g.us' };
  const config = configFor(dir);
  config.sources.whatsapp.groups.push(second);
  store.requestWhatsAppHistory({ fromTs: 1_000, toTs: 5_000, groupsTotal: 2 });
  const sock = { groupHistoryDiagnostics: new Map() };

  const result = await processNextHistoryRequest({
    config, store, sock, collectorRunId: 99,
    fetchHistory: async (_sock, requestedGroup) => {
      if (requestedGroup.jid === second.jid) throw new Error('upstream unavailable');
      sock.groupHistoryDiagnostics.set(group.jid, {
        status: 'complete', oldestAt: 1_000, newestAt: 5_000, delivered: 0, batches: 1,
      });
      return [];
    },
    recordEvent: () => {},
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.groups.map(({ name, status }) => ({ name, status })), [
    { name: 'Group A', status: 'complete' },
    { name: 'Group B', status: 'failed' },
  ]);
});

test('collector reports a history group as failed when WhatsApp returns no history page', async (context) => {
  const { dir, store } = temporary(context);
  store.requestWhatsAppHistory({ fromTs: 1_000, toTs: 5_000, groupsTotal: 1 });
  const sock = { groupHistoryDiagnostics: new Map() };

  const result = await processNextHistoryRequest({
    config: configFor(dir), store, sock, collectorRunId: 99,
    fetchHistory: async () => {
      sock.groupHistoryDiagnostics.set(group.jid, {
        status: 'unknown', delivered: 0, batches: 1, reason: 'history_no_response',
      });
      return [];
    },
    recordEvent: () => {},
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.groups[0].status, 'failed');
  assert.equal(result.groups[0].reason, 'history_no_response');
});
