#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '@whiskeysockets/baileys';

import { loadJobsConfig } from './config.mjs';
import { describeFailure } from './diagnostics.mjs';
import { acquireSingleInstance } from './single-instance.mjs';
import { connectWhatsApp, disconnectWhatsApp, shouldRetryWhatsAppConnection } from './sources/whatsapp-client.mjs';
import { fetchGroupMessagesSince } from './sources/whatsapp-history.mjs';
import { queueIncomingMessages, verifyConfiguredGroups } from './sources/whatsapp.mjs';
import { createJobStore } from './store.mjs';

const RECEIPT_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function reconnectDelay(attempt, { baseMs = 1_000, maxMs = 30_000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.round(exponential * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
}

export function hasContinuityGap(previousHeartbeatAt, heartbeatAt, staleAfterMs = 20_000) {
  return Number(heartbeatAt) - Number(previousHeartbeatAt) > Math.max(10_000, Number(staleAfterMs) || 20_000);
}

export function discardExpiredWhatsAppBacklog({ store, retentionDays = 7, now = Date.now } = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new Error('WhatsApp backlogRetentionDays must be between 1 and 365');
  }
  const discardedAt = Number(now());
  const beforeTs = discardedAt - days * DAY_MS;
  return {
    discarded: store.discardOldWhatsAppMessages({ beforeTs, discardedAt }),
    beforeTs,
    retentionDays: days,
  };
}

function statusCodeFor(lastDisconnect) {
  return new Boom(lastDisconnect?.error)?.output?.statusCode ?? null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processNextHistoryRequest({
  config,
  store,
  sock,
  collectorRunId,
  fetchHistory = fetchGroupMessagesSince,
  recordEvent = (stage, status, options = {}) => store.recordCollectorEvent(collectorRunId, {
    stage, status, count: options.count, details: options.details,
  }),
  now = Date.now,
} = {}) {
  const request = store.claimNextWhatsAppHistoryRequest({ ownerPid: process.pid, startedAt: now() });
  if (!request) return null;
  const groups = config.sources.whatsapp?.groups || [];
  const groupJids = new Set(groups.map((group) => group.jid));
  const totals = { received: 0, queued: 0, duplicates: 0, ignored: 0, rejected: 0, completed: 0 };
  let completedGroups = 0;
  let failedGroups = 0;
  recordEvent('history-backfill', 'started', {
    details: { requestId: request.id, groups: groups.length, fromTs: request.fromTs, toTs: request.toTs },
  });

  for (const group of groups) {
    const requestedGroup = request.groups.find((item) => item.name === group.name);
    const requestedFrom = requestedGroup?.requestedFrom ?? request.fromTs;
    store.updateWhatsAppHistoryRequest(request.id, { currentGroup: group.name, groupsCompleted: completedGroups + failedGroups });
    recordEvent('history-request-sent', 'started', { details: { requestId: request.id, group: group.name, requestedFrom } });
    try {
      const messages = await fetchHistory(sock, group, requestedFrom, {
        store,
        untilMs: request.toTs,
        anchorWaitMs: 10_000,
        maxBatches: 20,
        totalTimeoutMs: 180_000,
      });
      const ingress = queueIncomingMessages({ messages, configuredGroupJids: groupJids, store, sinceMs: requestedFrom });
      const coverage = sock.groupHistoryDiagnostics?.get(group.jid) || {};
      const status = coverage.status === 'complete' ? 'complete' : messages.length > 0 ? 'partial' : 'failed';
      if (status === 'complete') completedGroups += 1;
      else failedGroups += 1;
      totals.received += messages.length;
      totals.queued += ingress.queued;
      totals.duplicates += ingress.duplicates;
      totals.ignored += ingress.ignored;
      totals.rejected += ingress.rejected;
      store.recordWhatsAppHistoryGroup(request.id, {
        name: group.name,
        status,
        delivered: messages.length,
        queued: ingress.queued,
        duplicates: ingress.duplicates,
        ignored: ingress.ignored,
        rejected: ingress.rejected,
        oldestAt: coverage.oldestAt ?? null,
        newestAt: coverage.newestAt ?? null,
        batches: Number(coverage.batches || 0),
        reason: coverage.reason || null,
        requestedFrom,
      });
      recordEvent('history-batch-received', status, {
        count: messages.length,
        details: {
          requestId: request.id, group: group.name, queued: ingress.queued,
          duplicates: ingress.duplicates, batches: Number(coverage.batches || 0),
          reason: coverage.reason || null,
        },
      });
    } catch (error) {
      failedGroups += 1;
      const failure = describeFailure(error, 'collection_failed');
      store.recordWhatsAppHistoryGroup(request.id, { name: group.name, status: 'failed', reason: failure.code, requestedFrom });
      recordEvent('history-request-failed', 'failed', { details: { requestId: request.id, group: group.name, ...failure } });
    }
    const finishedGroups = completedGroups + failedGroups;
    totals.completed = finishedGroups;
    store.updateWhatsAppHistoryRequest(request.id, {
      groupsCompleted: finishedGroups,
      messagesReceived: totals.received,
      messagesQueued: totals.queued,
      duplicates: totals.duplicates,
      ignored: totals.ignored,
      rejected: totals.rejected,
    });
  }

  const status = failedGroups === 0 ? 'complete' : completedGroups === 0 ? 'failed' : 'partial';
  const failure = status === 'failed' ? describeFailure(null, 'history_not_delivered') : null;
  store.finishWhatsAppHistoryRequest(request.id, { status, failure, finishedAt: now() });
  recordEvent('history-backfill', status, {
    count: totals.received,
    details: { requestId: request.id, groupsCompleted: totals.completed, groupsFailed: failedGroups, queued: totals.queued },
  });
  return store.getWhatsAppHistoryRequest(request.id);
}

export async function runWhatsAppCollector({
  config,
  store,
  connect = connectWhatsApp,
  disconnect = disconnectWhatsApp,
  sleep = wait,
  now = Date.now,
  registerSignals = true,
} = {}) {
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) throw new Error('WhatsApp source is disabled.');
  if (!whatsapp.authAbsPath) throw new Error('WhatsApp authPath is not configured.');

  const collectorConfig = whatsapp.collector || {};
  const groups = whatsapp.groups || [];
  const groupJids = new Set(groups.map((group) => group.jid));
  const runId = Number(store.startCollectorRun({ groupsExpected: groups.length }));
  store.requeueInterruptedWhatsAppHistoryRequests?.();
  let stopping = false;
  let activeSock = null;
  let stopResolve;
  const stopPromise = new Promise((resolve) => { stopResolve = resolve; });
  let receiptQueue = Promise.resolve();
  let reconnects = 0;
  let connectionActive = false;
  let lastHeartbeatTick = now();

  const heartbeat = setInterval(() => {
    try {
      const heartbeatAt = now();
      const staleAfterMs = Math.max(10_000, Number(collectorConfig.staleAfterMs || 20_000));
      if (connectionActive && hasContinuityGap(lastHeartbeatTick, heartbeatAt, staleAfterMs)) {
        store.updateCollectorRun(runId, { status: 'connected', stage: 'connected', connectedAt: heartbeatAt });
        store.recordCollectorEvent(runId, { stage: 'continuity-gap', status: 'warning',
          details: { ...describeFailure(null, 'collector_gap'), gapMs: heartbeatAt - lastHeartbeatTick } });
      } else {
        store.updateCollectorRun(runId);
      }
      lastHeartbeatTick = heartbeatAt;
    }
    catch { /* The terminal failure path will report an unavailable database. */ }
  }, Math.max(1_000, Number(collectorConfig.heartbeatMs || 5_000)));
  heartbeat.unref();

  const stop = () => {
    stopping = true;
    stopResolve();
  };
  const signalHandlers = registerSignals
    ? [['SIGINT', stop], ['SIGTERM', stop]]
    : [];
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  const record = (stage, status, options = {}) => {
    store.updateCollectorRun(runId, { status, stage, ...(options.update || {}) });
    store.recordCollectorEvent(runId, { stage, status, count: options.count, details: options.details });
  };

  try {
    record('startup', 'starting');
    const startupRetention = discardExpiredWhatsAppBacklog({
      store,
      retentionDays: collectorConfig.backlogRetentionDays ?? 7,
      now,
    });
    if (startupRetention.discarded > 0) {
      store.recordCollectorEvent(runId, {
        stage: 'backlog-retention',
        status: 'complete',
        count: startupRetention.discarded,
        details: { retentionDays: startupRetention.retentionDays },
      });
    }
    while (!stopping) {
      record(reconnects ? 'reconnect' : 'connecting', reconnects ? 'reconnecting' : 'connecting');
      let closeResolve;
      const closePromise = new Promise((resolve) => { closeResolve = resolve; });

      try {
        const connectPromise = connect(whatsapp.authAbsPath, {
          configuredGroupJids: groupJids,
          waitForHistory: false,
          onQr() {
            record('pairing', 'pairing_required', { details: describeFailure(null, 'pairing_required') });
          },
          onConnectionUpdate(update, sock) {
            activeSock = sock;
            if (update.connection === 'close') closeResolve(update.lastDisconnect);
          },
          onIngressError(error) {
            closeResolve({ error });
          },
          onMessages(messages, sock) {
            const batch = queueIncomingMessages({ messages, configuredGroupJids: groupJids, store, sinceMs: 0 });
            const retention = discardExpiredWhatsAppBacklog({
              store,
              retentionDays: collectorConfig.backlogRetentionDays ?? 7,
              now,
            });
            if (retention.discarded > 0) {
              store.recordCollectorEvent(runId, {
                stage: 'backlog-retention',
                status: 'complete',
                count: retention.discarded,
                details: { retentionDays: retention.retentionDays },
              });
            }
            const received = batch.queued + batch.duplicates + batch.ignored + batch.rejected;
            if (received === 0) return;
            const lastMessageAt = messages.reduce((latest, message) => Math.max(latest, Number(message.messageTimestamp || 0) * 1_000), 0);
            store.updateCollectorRun(runId, {
              messagesReceived: received,
              messagesQueued: batch.queued,
              duplicates: batch.duplicates,
              ignored: batch.ignored,
              rejected: batch.rejected,
              ...(lastMessageAt ? { lastMessageAt } : {}),
            });
            store.recordCollectorEvent(runId, {
              stage: 'message-ingress',
              status: batch.rejected ? 'partial' : 'complete',
              count: received,
              details: batch,
            });

            if (!whatsapp.markRead) return;
            const keys = messages.filter((message) =>
              groupJids.has(message.key?.remoteJid) &&
              message.key?.id && !message.key?.fromMe &&
              ['pending', 'done'].includes(store.getMessageState(message.key.id)?.status),
            ).map((message) => message.key);
            if (!keys.length) return;
            receiptQueue = receiptQueue.then(async () => {
              let sent = 0;
              try {
                for (let offset = 0; offset < keys.length; offset += RECEIPT_BATCH_SIZE) {
                  const receiptBatch = keys.slice(offset, offset + RECEIPT_BATCH_SIZE);
                  await sock.readMessages(receiptBatch);
                  sent += receiptBatch.length;
                }
                store.updateCollectorRun(runId, { receiptsSent: sent });
                store.recordCollectorEvent(runId, { stage: 'read-receipts', status: 'complete', count: sent });
              } catch (error) {
                store.recordCollectorEvent(runId, { stage: 'read-receipts', status: 'failed', count: sent, details: describeFailure(error, 'read_failed') });
              }
            });
          },
        });

        const connected = await Promise.race([connectPromise, stopPromise.then(() => null)]);
        if (!connected || stopping) break;
        activeSock = connected;
        connectionActive = true;
        const connectedAt = now();
        record('connected', 'connected', { update: { connectedAt } });

        const verification = await verifyConfiguredGroups(config, connected);
        const safeGroups = verification.map(({ name, found, liveName, participants }) => ({ name, found, liveName, participants }));
        const found = safeGroups.filter((group) => group.found).length;
        record('group-verification', found === groups.length ? 'complete' : 'partial', {
          count: found,
          update: { status: 'connected', groupsFound: found, groupsExpected: groups.length },
          details: { groups: safeGroups },
        });

        let lastDisconnect;
        while (!stopping) {
          const outcome = await Promise.race([
            closePromise.then((value) => ({ type: 'close', value })),
            stopPromise.then(() => ({ type: 'stop', value: null })),
            sleep(2_000).then(() => ({ type: 'poll', value: null })),
          ]);
          if (outcome.type === 'stop') break;
          if (outcome.type === 'close') { lastDisconnect = outcome.value; break; }
          await processNextHistoryRequest({ config, store, sock: connected, collectorRunId: runId });
        }
        connectionActive = false;
        if (stopping) break;
        const statusCode = statusCodeFor(lastDisconnect);
        const failure = describeFailure(
          statusCode === DisconnectReason.connectionReplaced
            ? new Error(`connection replaced status ${statusCode}`)
            : lastDisconnect?.error,
          'network_error',
        );
        store.recordCollectorEvent(runId, { stage: 'connection-closed', status: 'failed', details: { ...failure, ...(statusCode ? { statusCode } : {}) } });

        if (statusCode === DisconnectReason.loggedOut) {
          record('pairing', 'pairing_required', { details: describeFailure(null, 'pairing_required') });
          break;
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          const replaced = describeFailure(new Error('connection replaced'));
          store.finishCollectorRun(runId, { status: 'failed', failure: replaced });
          return { id: runId, status: 'failed', failure: replaced };
        }
        if (!shouldRetryWhatsAppConnection(statusCode)) {
          store.finishCollectorRun(runId, { status: 'failed', failure });
          return { id: runId, status: 'failed', failure };
        }
      } catch (error) {
        connectionActive = false;
        if (stopping) break;
        const failure = describeFailure(error, 'network_error');
        store.recordCollectorEvent(runId, { stage: 'connect', status: 'failed', details: failure });
        if (['pairing_required', 'connection_replaced', 'collector_already_running'].includes(failure.code)) {
          store.finishCollectorRun(runId, { status: failure.code === 'pairing_required' ? 'pairing_required' : 'failed', failure });
          return { id: runId, status: failure.code === 'pairing_required' ? 'pairing_required' : 'failed', failure };
        }
      } finally {
        connectionActive = false;
        await disconnect(activeSock);
        activeSock = null;
      }

      reconnects += 1;
      store.updateCollectorRun(runId, { reconnects: 1 });
      const delayMs = reconnectDelay(reconnects, {
        baseMs: Number(collectorConfig.reconnectBaseMs || 1_000),
        maxMs: Number(collectorConfig.reconnectMaxMs || 30_000),
      });
      store.recordCollectorEvent(runId, { stage: 'reconnect-wait', status: 'started', details: { attempt: reconnects, delayMs } });
      await Promise.race([sleep(delayMs), stopPromise]);
    }

    await receiptQueue;
    store.recordCollectorEvent(runId, { stage: 'shutdown', status: 'complete' });
    store.finishCollectorRun(runId, { status: 'stopped' });
    return { id: runId, status: 'stopped' };
  } catch (error) {
    const failure = describeFailure(error);
    try {
      store.recordCollectorEvent(runId, { stage: 'collector', status: 'failed', details: failure });
      store.finishCollectorRun(runId, { status: 'failed', failure });
    } catch { /* The original durable-storage failure is still returned. */ }
    return { id: runId, status: 'failed', failure };
  } finally {
    clearInterval(heartbeat);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    await disconnect(activeSock);
  }
}

export async function startWhatsAppCollector() {
  const config = loadJobsConfig();
  const lock = acquireSingleInstance(path.join(config.dataDir, 'whatsapp-collector.lock'));
  const store = createJobStore(config.jobsDbPath);
  try {
    const result = await runWhatsAppCollector({ config, store });
    console.log(`WhatsApp collector #${result.id}: ${result.status}`);
    if (result.status === 'failed' && result.failure?.code !== 'connection_replaced') process.exitCode = 1;
  } finally {
    try { store.pruneDiagnostics(); }
    catch { console.error('JobOps diagnostic retention unavailable; existing records were preserved.'); }
    store.close();
    lock.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startWhatsAppCollector().catch((error) => {
    const failure = describeFailure(error);
    console.error(`WhatsApp collector failed: ${failure.code}. ${failure.reason}`);
    process.exitCode = failure.code === 'collector_already_running' ? 0 : 1;
  });
}
