import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { createJobStore } from '../scripts/jobs/store.mjs';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-store-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

test('job store deduplicates tracking variants and remembers presentation state', () => {
  const store = newStore();
  const first = store.recordSighting({
    url: 'https://example.com/jobs/42?utm_source=whatsapp',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'whatsapp',
    seenAt: 100,
  });
  const second = store.recordSighting({
    url: 'https://example.com/jobs/42?utm_source=linkedin',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'ats',
    seenAt: 200,
  });

  assert.equal(first.jobKey, second.jobKey);
  assert.equal(store.countJobs(), 1);

  store.saveEvaluation(first.jobKey, {
    company: 'Example',
    title: 'Backend Engineer',
    summary: 'Backend services.',
    score: 4.3,
    fitLabel: 'מתאים',
    decisionReason: 'Strong match.',
    fitBreakdown: { cvMatch: 5, seniority: 4, roleScope: 4, location: 5, sector: 5, uncertainties: [] },
    suitable: true,
    applyUrl: first.canonicalUrl,
    activeStatus: 'active',
    contentHash: 'content-v1',
    profileHash: 'profile-v1',
    criteriaVersion: 'v1',
    evaluatedAt: 300,
  });

  assert.equal(store.listUnpresentedSuitable().length, 1);
  store.markPresented([first.jobKey], 400);
  assert.equal(store.listUnpresentedSuitable().length, 0);
  store.close();
});

test('failed messages remain retryable while completed messages do not', () => {
  const store = newStore();
  store.markMessageFailed({ messageId: 'm1', groupJid: 'g1', error: 'network' });
  assert.equal(store.shouldProcessMessage('m1'), true);

  store.markMessageDone({ messageId: 'm1', groupJid: 'g1', timestamp: 123 });
  assert.equal(store.shouldProcessMessage('m1'), false);
  store.close();
});

test('WhatsApp inbox is idempotent and erases message text after processing', () => {
  const store = newStore();
  const message = {
    messageId: 'queued-message',
    groupJid: 'group-a@g.us',
    timestamp: 1_000,
    text: 'Backend job https://example.com/jobs/backend',
  };

  assert.equal(store.queueWhatsAppMessage(message), true);
  assert.equal(store.queueWhatsAppMessage(message), false);
  assert.deepEqual(store.listPendingWhatsAppMessages('group-a@g.us', { untilMs: 2_000 }), [{
    messageId: 'queued-message',
    groupJid: 'group-a@g.us',
    timestamp: 1_000,
    text: message.text,
  }]);
  assert.deepEqual(store.getMessageState('queued-message'), { status: 'pending', hasText: true });
  assert.deepEqual(store.listWhatsAppMessageKeys('group-a@g.us'), [{
    id: 'queued-message',
    remoteJid: 'group-a@g.us',
    fromMe: false,
  }]);

  store.markMessageDone({ messageId: 'queued-message', groupJid: 'group-a@g.us', timestamp: 1_000 });
  assert.deepEqual(store.listPendingWhatsAppMessages('group-a@g.us', { untilMs: 2_000 }), []);
  assert.deepEqual(store.getMessageState('queued-message'), { status: 'done', hasText: false });
  store.close();
});

test('WhatsApp backlog reports bounded metadata without exposing message bodies', () => {
  const store = newStore();
  store.queueWhatsAppMessage({
    messageId: 'older-pending', groupJid: 'group-a@g.us', timestamp: 1_000,
    text: 'private older text https://example.com/older',
  });
  store.queueWhatsAppMessage({
    messageId: 'newer-failed', groupJid: 'group-a@g.us', timestamp: 2_000,
    text: 'private newer text https://example.com/newer',
  });
  store.markMessageFailed({ messageId: 'newer-failed', groupJid: 'group-a@g.us', error: 'temporary' });
  store.queueWhatsAppMessage({
    messageId: 'other-group', groupJid: 'group-b@g.us', timestamp: 3_000,
    text: 'private other text https://example.com/other',
  });

  const backlog = store.getWhatsAppBacklogStats({ sinceMs: 1_500, untilMs: 3_500 });

  assert.equal(backlog.total, 2);
  assert.equal(backlog.failed, 1);
  assert.equal(backlog.oldestAt, 2_000);
  assert.equal(backlog.newestAt, 3_000);
  assert.deepEqual(backlog.groups.map(({ groupJid, total, failed }) => ({ groupJid, total, failed })), [
    { groupJid: 'group-a@g.us', total: 1, failed: 1 },
    { groupJid: 'group-b@g.us', total: 1, failed: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(backlog), /private|example\.com/);
  assert.deepEqual(
    store.listPendingWhatsAppMessages('group-a@g.us', { sinceMs: 0, untilMs: 5_000, order: 'desc' })
      .map(({ messageId }) => messageId),
    ['newer-failed', 'older-pending'],
  );
  store.close();
});

test('WhatsApp retention erases expired backlog bodies but keeps terminal deduplication keys', () => {
  const store = newStore();
  store.queueWhatsAppMessage({
    messageId: 'expired-pending', groupJid: 'group-a@g.us', timestamp: 1_000,
    text: 'private expired text https://example.com/expired',
  });
  store.queueWhatsAppMessage({
    messageId: 'expired-failed', groupJid: 'group-a@g.us', timestamp: 2_000,
    text: 'private failed text https://example.com/failed',
  });
  store.markMessageFailed({ messageId: 'expired-failed', groupJid: 'group-a@g.us', error: 'temporary' });
  store.queueWhatsAppMessage({
    messageId: 'recent-pending', groupJid: 'group-a@g.us', timestamp: 9_000,
    text: 'recent text https://example.com/recent',
  });

  const discarded = store.discardOldWhatsAppMessages({ beforeTs: 5_000, discardedAt: 10_000 });

  assert.equal(discarded, 2);
  assert.deepEqual(store.getMessageState('expired-pending'), { status: 'done', hasText: false });
  assert.deepEqual(store.getMessageState('expired-failed'), { status: 'done', hasText: false });
  assert.deepEqual(store.getMessageState('recent-pending'), { status: 'pending', hasText: true });
  assert.equal(store.shouldProcessMessage('expired-pending'), false);
  assert.equal(store.queueWhatsAppMessage({
    messageId: 'expired-pending', groupJid: 'group-a@g.us', timestamp: 1_000,
    text: 'private replayed text',
  }), false);
  assert.deepEqual(store.listPendingWhatsAppMessages('group-a@g.us', { untilMs: 20_000 })
    .map(({ messageId }) => messageId), ['recent-pending']);
  assert.deepEqual(store.listWhatsAppMessageKeys('group-a@g.us').map(({ id }) => id), [
    'recent-pending', 'expired-failed', 'expired-pending',
  ]);
  store.close();
});

test('WhatsApp history requests are durable, single-flight and retain safe per-group progress', () => {
  const store = newStore();
  const first = store.requestWhatsAppHistory({ fromTs: 1_000, toTs: 5_000, groupsTotal: 2, createdAt: 10 });
  const duplicate = store.requestWhatsAppHistory({ fromTs: 2_000, toTs: 6_000, groupsTotal: 2, createdAt: 11 });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.request.id, first.request.id);

  const claimed = store.claimNextWhatsAppHistoryRequest({ ownerPid: 123, startedAt: 20 });
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.ownerPid, 123);
  store.recordWhatsAppHistoryGroup(claimed.id, {
    name: 'Group A', status: 'complete', delivered: 50, queued: 40,
    duplicates: 10, oldestAt: 1_000, newestAt: 5_000, batches: 1,
  });
  store.updateWhatsAppHistoryRequest(claimed.id, {
    currentGroup: 'Group A', groupsCompleted: 1, messagesReceived: 50,
    messagesQueued: 40, duplicates: 10,
  });
  store.finishWhatsAppHistoryRequest(claimed.id, { status: 'complete', finishedAt: 30 });

  const completed = store.getLatestWhatsAppHistoryRequest();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.messagesReceived, 50);
  assert.equal(completed.groups[0].name, 'Group A');
  assert.doesNotMatch(JSON.stringify(completed), /@g\.us/);
  store.close();
});

test('WhatsApp history keeps the per-group collection cursor captured when the request is created', () => {
  const store = newStore();
  const created = store.requestWhatsAppHistory({
    fromTs: 1_000,
    toTs: 10_000,
    groupsTotal: 2,
    groups: [
      { name: 'Group A', requestedFrom: 4_000 },
      { name: 'Group B', requestedFrom: 7_000 },
    ],
    createdAt: 20,
  });

  assert.deepEqual(created.request.groups.map(({ name, status, requestedFrom }) => ({ name, status, requestedFrom })), [
    { name: 'Group A', status: 'pending', requestedFrom: 4_000 },
    { name: 'Group B', status: 'pending', requestedFrom: 7_000 },
  ]);
  const claimed = store.claimNextWhatsAppHistoryRequest({ ownerPid: process.pid, startedAt: 30 });
  store.recordWhatsAppHistoryGroup(claimed.id, {
    name: 'Group A', status: 'complete', requestedFrom: 4_000, delivered: 3,
  });
  assert.equal(store.getWhatsAppHistoryRequest(claimed.id).groups[0].requestedFrom, 4_000);
  store.close();
});

test('WhatsApp group collection stats expose timestamps and counts without message text', () => {
  const store = newStore();
  store.queueWhatsAppMessage({ messageId: 'done', groupJid: 'group-a@g.us', timestamp: 1_000, text: 'private done' });
  store.markMessageDone({ messageId: 'done', groupJid: 'group-a@g.us', timestamp: 1_000 });
  store.queueWhatsAppMessage({ messageId: 'pending', groupJid: 'group-a@g.us', timestamp: 2_000, text: 'private pending' });
  store.markWhatsAppMessagesRead([{ id: 'pending', remoteJid: 'group-a@g.us' }], { readAt: 2_500 });
  store.queueWhatsAppMessage({ messageId: 'failed', groupJid: 'group-a@g.us', timestamp: 3_000, text: 'private failed' });
  store.markMessageFailed({ messageId: 'failed', groupJid: 'group-a@g.us', error: 'temporary' });

  const stats = store.getWhatsAppGroupCollectionStats('group-a@g.us');
  assert.deepEqual(stats, {
    totalCollected: 3,
    pending: 2,
    failed: 1,
    lastCollectedAt: 3_000,
    lastProcessedAt: 1_000,
    lastReadAt: 2_500,
    readTotal: 1,
  });
  assert.doesNotMatch(JSON.stringify(stats), /private/);
  store.close();
});

test('an interrupted WhatsApp history request is safely requeued for the next collector', () => {
  const store = newStore();
  store.requestWhatsAppHistory({ fromTs: 1_000, toTs: 5_000, groupsTotal: 1 });
  const claimed = store.claimNextWhatsAppHistoryRequest({ ownerPid: 99_999_999, startedAt: 20 });
  store.recordWhatsAppHistoryGroup(claimed.id, { name: 'Group A', status: 'partial', delivered: 10 });

  assert.equal(store.requeueInterruptedWhatsAppHistoryRequests(), 1);
  const requeued = store.getLatestWhatsAppHistoryRequest();
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.ownerPid, null);
  assert.deepEqual(requeued.groups.map(({ name, status, delivered }) => ({ name, status, delivered })), [
    { name: 'Group A', status: 'pending', delivered: 0 },
  ]);
  assert.equal(store.claimNextWhatsAppHistoryRequest({ ownerPid: process.pid, startedAt: 30 }).status, 'running');
  store.close();
});

test('cached pages expire according to TTL', () => {
  const store = newStore();
  store.savePage({
    canonicalUrl: 'https://example.com/jobs/42',
    finalUrl: 'https://example.com/jobs/42',
    status: 'active',
    content: 'job content',
    contentHash: 'abc',
    fetchedAt: 1_000,
  });

  assert.ok(store.getFreshPage('https://example.com/jobs/42', { now: 1_500, ttlMs: 1_000 }));
  assert.equal(store.getFreshPage('https://example.com/jobs/42', { now: 2_001, ttlMs: 1_000 }), null);
  store.close();
});

test('jobs whose page or scoring failed remain available for a later retry', () => {
  const store = newStore();
  const sighting = store.recordSighting({
    url: 'https://example.com/jobs/retry-me',
    source: 'WhatsApp: Group A',
    seenAt: 1_000,
  });

  assert.deepEqual(store.listPendingEvaluation(), [{
    jobKey: sighting.jobKey,
    canonicalUrl: sighting.canonicalUrl,
    url: 'https://example.com/jobs/retry-me',
    company: '',
    title: '',
    source: 'WhatsApp: Group A',
  }]);

  store.markEvaluationFailure(sighting.jobKey, {
    code: 'page_uncertain',
    reason: 'Dynamic page could not be rendered.',
    attemptedAt: 1_500,
  });
  const failed = store.getJob(sighting.jobKey);
  assert.equal(failed.last_error_code, 'page_uncertain');
  assert.equal(failed.last_error_reason, 'Dynamic page could not be rendered.');
  assert.equal(failed.last_attempted_at, 1_500);
  assert.equal(store.listPendingEvaluation().length, 1);

  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Backend role.',
    score: 4.2, fitLabel: 'מתאים', decisionReason: 'Relevant role.', suitable: true,
    applyUrl: sighting.canonicalUrl, activeStatus: 'active', contentHash: 'content-v1',
    profileHash: 'profile-v1', criteriaVersion: 'v1', evaluatedAt: 2_000,
  });
  const evaluated = store.getJob(sighting.jobKey);
  assert.equal(evaluated.last_error_code, null);
  assert.equal(evaluated.last_error_reason, null);
  assert.deepEqual(store.listPendingEvaluation(), []);
  store.close();
});

test('a failed re-evaluation keeps the previous decision and remains retryable', () => {
  const store = newStore();
  const sighting = store.recordSighting({
    url: 'https://example.com/jobs/recheck-me',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'ATS: example',
    seenAt: 1_000,
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Previous evaluation.',
    score: 3.2, fitLabel: 'לא מתאים', decisionReason: 'Previous decision.', suitable: false,
    applyUrl: sighting.canonicalUrl, activeStatus: 'active', contentHash: 'old-content',
    profileHash: 'old-profile', criteriaVersion: 'old-criteria', evaluatedAt: 2_000,
  });

  store.markEvaluationFailure(sighting.jobKey, {
    code: 'page_fetch_failed',
    reason: 'Temporary upstream failure.',
    attemptedAt: 3_000,
  });

  const failed = store.getJob(sighting.jobKey);
  assert.equal(failed.evaluated_at, 2_000);
  assert.equal(failed.last_error_code, 'page_fetch_failed');
  assert.equal(store.listPendingEvaluation().some((job) => job.jobKey === sighting.jobKey), true);
  store.close();
});

test('listPendingEvaluation excludes chosen error codes but keeps brand-new and other-failed candidates', () => {
  const store = newStore();
  const fresh = store.recordSighting({ url: 'https://example.com/jobs/fresh', source: 'ATS: example', seenAt: 100 });
  const blocked = store.recordSighting({ url: 'https://example.com/jobs/blocked', source: 'ATS: example', seenAt: 200 });
  const timedOut = store.recordSighting({ url: 'https://example.com/jobs/timeout', source: 'ATS: example', seenAt: 300 });
  store.markEvaluationFailure(blocked.jobKey, { code: 'bot_challenge', reason: 'Anti-bot wall.', attemptedAt: 400 });
  store.markEvaluationFailure(timedOut.jobKey, { code: 'timeout', reason: 'Slow host.', attemptedAt: 500 });

  const all = store.listPendingEvaluation();
  assert.deepEqual(all.map((job) => job.jobKey).sort(), [blocked.jobKey, fresh.jobKey, timedOut.jobKey].sort());

  const excluding = store.listPendingEvaluation({ excludeErrorCodes: ['bot_challenge', 'access_blocked'] });
  assert.deepEqual(excluding.map((job) => job.jobKey).sort(), [fresh.jobKey, timedOut.jobKey].sort());
  store.close();
});

test('getFailureBreakdown groups outstanding failures by code and ignores archived jobs', () => {
  const store = newStore();
  const a = store.recordSighting({ url: 'https://example.com/jobs/a', source: 'ATS: example', seenAt: 100 });
  const b = store.recordSighting({ url: 'https://example.com/jobs/b', source: 'ATS: example', seenAt: 200 });
  const c = store.recordSighting({ url: 'https://example.com/jobs/c', source: 'ATS: example', seenAt: 300 });
  store.markEvaluationFailure(a.jobKey, { code: 'bot_challenge', reason: 'Anti-bot wall.', attemptedAt: 400 });
  store.markEvaluationFailure(b.jobKey, { code: 'bot_challenge', reason: 'Anti-bot wall.', attemptedAt: 500 });
  store.markEvaluationFailure(c.jobKey, { code: 'timeout', reason: 'Slow host.', attemptedAt: 600 });

  assert.deepEqual(store.getFailureBreakdown(), [
    { code: 'bot_challenge', count: 2 },
    { code: 'timeout', count: 1 },
  ]);

  assert.equal(store.archiveJob(a.jobKey, 700), true);
  // Both codes are tied at 1 now; the query breaks ties alphabetically by code.
  assert.deepEqual(store.getFailureBreakdown(), [
    { code: 'bot_challenge', count: 1 },
    { code: 'timeout', count: 1 },
  ]);
  store.close();
});

test('archiveJobsByErrorCode clears only the matching outstanding failures and no-ops on an empty list', () => {
  const store = newStore();
  const a = store.recordSighting({ url: 'https://example.com/jobs/a', source: 'ATS: example', seenAt: 100 });
  const b = store.recordSighting({ url: 'https://example.com/jobs/b', source: 'ATS: example', seenAt: 200 });
  store.markEvaluationFailure(a.jobKey, { code: 'bot_challenge', reason: 'Anti-bot wall.', attemptedAt: 300 });
  store.markEvaluationFailure(b.jobKey, { code: 'timeout', reason: 'Slow host.', attemptedAt: 400 });

  assert.deepEqual(store.archiveJobsByErrorCode([], 500), { archived: 0 });
  assert.equal(store.getJob(a.jobKey).archived_at, null);

  assert.deepEqual(store.archiveJobsByErrorCode(['bot_challenge', 'access_blocked'], 600), { archived: 1 });
  assert.equal(store.getJob(a.jobKey).archived_at, 600);
  assert.equal(store.getJob(b.jobKey).archived_at, null);
  assert.deepEqual(store.getFailureBreakdown(), [{ code: 'timeout', count: 1 }]);
  assert.equal(store.listPendingEvaluation().some((job) => job.jobKey === a.jobKey), false);

  // Idempotent: nothing left to archive for that code.
  assert.deepEqual(store.archiveJobsByErrorCode(['bot_challenge'], 700), { archived: 0 });
  store.close();
});

test('last successful run must cover every requested source', () => {
  const store = newStore();
  const atsOnly = store.startRun({ fromTs: 0, toTs: 10, sources: ['ats'], startedAt: 10 });
  store.finishRun(atsOnly, { status: 'success', finishedAt: 20 });
  const full = store.startRun({ fromTs: 0, toTs: 30, sources: ['ats', 'whatsapp'], startedAt: 30 });
  store.finishRun(full, { status: 'success', finishedAt: 40 });
  const newerAts = store.startRun({ fromTs: 0, toTs: 50, sources: ['ats'], startedAt: 50 });
  store.finishRun(newerAts, { status: 'success', finishedAt: 60 });

  assert.equal(store.getLastSuccessfulRun(['ats']).id, Number(newerAts));
  assert.equal(store.getLastSuccessfulRun(['ats', 'whatsapp']).id, Number(full));
  store.close();
});

test('diagnostic retention keeps only recent evidence and durable success checkpoints', () => {
  const store = newStore();
  const runIds = [];
  for (let index = 0; index < 6; index += 1) {
    const runId = store.startRun({
      fromTs: index,
      toTs: index + 1,
      sources: index === 0 ? ['whatsapp'] : ['ats'],
      startedAt: 100 + index,
    });
    store.recordRunEvent(runId, { source: 'system', scope: 'run', stage: 'run', status: 'started', createdAt: 100 + index });
    store.finishRun(runId, { status: index === 0 || index === 2 ? 'success' : 'failed', finishedAt: 200 + index });
    runIds.push(Number(runId));
  }

  for (let index = 0; index < 5; index += 1) {
    const actionId = store.startAction(`action-${index}`, { ownerPid: 1 });
    store.updateAction(actionId, { status: 'success', finishedAt: 300 + index });
    const collectorId = store.startCollectorRun({ ownerPid: 1, startedAt: 400 + index });
    store.recordCollectorEvent(collectorId, { stage: 'connected', status: 'complete', createdAt: 400 + index });
    store.finishCollectorRun(collectorId, { status: 'stopped', finishedAt: 500 + index });
  }

  const result = store.pruneDiagnostics({ keepRecent: 3 });

  assert.equal(store.getRun(runIds[0]).events.length, 0, 'old WhatsApp success survives only as a compact checkpoint');
  assert.equal(store.getRun(runIds[1]), null, 'old failed run is deleted');
  assert.equal(store.getLastSuccessfulRun(['whatsapp']).id, runIds[0]);
  assert.equal(store.getLastSuccessfulRun(['ats']).id, runIds[2]);
  assert.equal(store.diagnosticHistory().filter((item) => item.kind === 'runs').length, 3);
  assert.equal(store.diagnosticHistory().filter((item) => item.kind === 'actions').length, 3);
  assert.equal(store.diagnosticHistory().filter((item) => item.kind === 'collectors').length, 3);
  assert.ok(result.runsDeleted >= 1);
  assert.ok(result.eventsDeleted >= 1);
  store.close();
});

test('run source summary is persisted for the dashboard', () => {
  const store = newStore();
  const runId = store.startRun({ fromTs: 10, toTs: 20, sources: ['ats', 'whatsapp'], startedAt: 30 });
  const details = {
    ats: { candidates: 2, errors: 0 },
    whatsapp: { candidates: 1, messages: 4, warning: null },
  };
  store.finishRun(runId, { status: 'success', details, finishedAt: 40 });

  const run = store.getLastRun();
  assert.equal(run.id, Number(runId));
  assert.deepEqual(run.details, details);
  store.close();
});

test('run audit events persist safe structured processing evidence', () => {
  const store = newStore();
  const runId = store.startRun({ fromTs: 10, toTs: 20, sources: ['whatsapp'], startedAt: 30 });

  store.recordRunEvent(runId, {
    source: 'whatsapp',
    scope: 'group',
    scopeKey: 'Group A',
    stage: 'history-coverage',
    status: 'incomplete',
    count: 0,
    details: { coverage: 'unknown', candidates: 0 },
    createdAt: 35,
  });
  store.finishRun(runId, { status: 'incomplete', finishedAt: 40 });

  const run = store.getLastRun();
  assert.deepEqual(run.events, [{
    id: 1,
    runId: Number(runId),
    source: 'whatsapp',
    scope: 'group',
    scopeKey: 'Group A',
    stage: 'history-coverage',
    status: 'incomplete',
    count: 0,
    details: { coverage: 'unknown', candidates: 0 },
    createdAt: 35,
  }]);
  assert.equal(store.getLastSuccessfulRun(['whatsapp']), null);
  store.close();
});

test('legacy WhatsApp state migration imports message dedup without moving checkpoints backwards', () => {
  const store = newStore();
  store.markMessageDone({ messageId: 'existing', groupJid: 'group-a', timestamp: 300 });
  store.setCheckpoint('whatsapp:group-a', 500);

  const result = store.importWhatsAppState({
    messages: [
      { message_id: 'existing', group_jid: 'group-a', wa_timestamp: 300, processed_at: 400 },
      { message_id: 'legacy', group_jid: 'group-a', wa_timestamp: 350, processed_at: 450 },
    ],
    checkpoints: [{ group_jid: 'group-a', last_wa_timestamp: 100 }],
  });

  assert.deepEqual(result, { messagesImported: 1, checkpointsSeen: 1 });
  assert.equal(store.shouldProcessMessage('legacy'), false);
  assert.equal(store.getCheckpoint('whatsapp:group-a'), 500);
  store.close();
});

test('dashboard shows only suitable jobs and rejected jobs retain dedup metadata only', () => {
  const store = newStore();
  const matching = store.recordSighting({
    url: 'https://example.com/jobs/backend',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'ats',
    seenAt: 100,
  });
  const rejected = store.recordSighting({
    url: 'https://example.com/jobs/frontend',
    company: 'Example',
    title: 'Frontend Engineer',
    source: 'whatsapp',
    seenAt: 200,
  });
  store.savePage({
    canonicalUrl: rejected.canonicalUrl,
    finalUrl: rejected.canonicalUrl,
    status: 'active',
    content: 'private rejected job description',
    contentHash: 'frontend-v1',
    fetchedAt: 250,
  });

  store.saveEvaluation(matching.jobKey, {
    company: 'Example',
    title: 'Backend Engineer',
    summary: 'Build reliable backend services.',
    score: 4.7,
    fitLabel: 'בול מתאים',
    decisionReason: 'Strong backend and distributed systems match.',
    fitBreakdown: { cvMatch: 5, seniority: 4, roleScope: 4, location: 5, sector: 5, uncertainties: [] },
    suitable: true,
    applyUrl: matching.canonicalUrl,
    activeStatus: 'active',
    contentHash: 'backend-v1',
    profileHash: 'profile-v1',
    criteriaVersion: 'v1',
    evaluatedAt: 300,
  });
  store.saveEvaluation(rejected.jobKey, {
    company: 'Example',
    title: 'Frontend Engineer',
    summary: 'Build browser interfaces.',
    score: 2.5,
    fitLabel: 'לא מתאים',
    decisionReason: 'The role is outside the requested domains.',
    suitable: false,
    applyUrl: rejected.canonicalUrl,
    activeStatus: 'active',
    contentHash: 'frontend-v1',
    profileHash: 'profile-v1',
    criteriaVersion: 'v1',
    evaluatedAt: 400,
  });
  store.markOpened([matching.jobKey], 500);

  const snapshot = store.getDashboardSnapshot();
  assert.deepEqual(snapshot.stats, {
    total: 2,
    suitable: 1,
    unopened: 0,
  });
  assert.deepEqual(snapshot.jobs.map((job) => Object.keys(job)), [
    ['jobKey', 'company', 'title', 'summary', 'score', 'fitLabel', 'decisionReason', 'applyUrl', 'suitable', 'activeStatus', 'lastSeenAt', 'openedAt', 'sourceKinds', 'fitBreakdown', 'resumeGap'],
  ]);
  assert.equal(snapshot.jobs[0].fitLabel, 'בול מתאים');
  assert.deepEqual(snapshot.jobs[0].fitBreakdown, {
    cvMatch: 5, seniority: 4, roleScope: 4, location: 5, sector: 5, uncertainties: [],
  });

  const rejectedRow = store.getJob(rejected.jobKey);
  assert.equal(rejectedRow.company, null);
  assert.equal(rejectedRow.title, null);
  assert.equal(rejectedRow.summary, null);
  assert.equal(rejectedRow.score, null);
  assert.equal(rejectedRow.fit_label, null);
  assert.equal(rejectedRow.decision_reason, null);
  assert.equal(rejectedRow.fit_breakdown_json, null);
  assert.equal(rejectedRow.apply_url, rejected.canonicalUrl);
  assert.equal(rejectedRow.sources_json, '[]');
  assert.ok(rejectedRow.company_role_key, 'company-role identity is retained only for dedup');
  assert.equal(store.getFreshPage(rejected.canonicalUrl, { now: 500, ttlMs: 1_000 }), null);

  store.recordSighting({
    url: rejected.canonicalUrl,
    company: 'Example',
    title: 'Frontend Engineer',
    source: 'WhatsApp: another group',
    seenAt: 600,
  });
  assert.equal(store.getJob(rejected.jobKey).sources_json, '[]');
  store.close();
});

test('archived jobs disappear from active queues while retaining only dedup identity', () => {
  const store = newStore();
  const sighting = store.recordSighting({
    url: 'https://example.com/jobs/reviewed?utm_source=whatsapp',
    company: 'Example',
    title: 'Senior Backend Engineer',
    source: 'whatsapp',
    seenAt: 100,
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example',
    title: 'Senior Backend Engineer',
    summary: 'Build distributed services.',
    score: 4.8,
    fitLabel: 'בול מתאים',
    decisionReason: 'Strong backend match.',
    suitable: true,
    applyUrl: sighting.canonicalUrl,
    activeStatus: 'active',
    contentHash: 'content-v1',
    profileHash: 'profile-v1',
    criteriaVersion: 'v1',
    evaluatedAt: 200,
  });

  assert.equal(store.archiveJob(sighting.jobKey, 300), true);
  assert.equal(store.getDashboardSnapshot().jobs.length, 0);
  assert.equal(store.listUnpresentedSuitable().length, 0);
  assert.equal(store.listUnopenedSuitable().length, 0);

  const archived = store.getJob(sighting.jobKey);
  assert.equal(archived.archived_at, 300);
  assert.equal(archived.company, null);
  assert.equal(archived.title, null);
  assert.equal(archived.summary, null);
  assert.equal(archived.score, null);
  assert.equal(archived.apply_url, sighting.canonicalUrl);
  assert.ok(archived.company_role_key);

  const repeated = store.recordSighting({
    url: 'https://example.com/jobs/reviewed?utm_source=ats',
    company: 'Example',
    title: 'Senior Backend Engineer',
    source: 'ats',
    seenAt: 400,
  });
  assert.equal(repeated.isNew, false);
  assert.equal(store.needsEvaluation(repeated.jobKey, {
    contentHash: 'new-content', profileHash: 'new-profile', criteriaVersion: 'v2', activeStatus: 'active',
  }), false);
  const repeatedRow = store.getJob(repeated.jobKey);
  assert.equal(repeatedRow.sources_json, '[]');
  assert.equal(repeatedRow.apply_url, sighting.canonicalUrl);
  store.close();
});

test('LinkedIn identity is the posting id across subdomains, slugs and tracking params', () => {
  const store = newStore();
  const first = store.recordSighting({ url: 'https://il.linkedin.com/jobs/view/backend-engineer-at-acme-4425439971?refId=a&trackingId=b',
    company: 'Acme', title: 'Backend Engineer', source: 'LinkedIn: Backend' });
  const second = store.recordSighting({ url: 'https://www.linkedin.com/jobs/search/?currentJobId=4425439971&geoId=101620260',
    company: 'Acme', title: 'Backend Engineer', source: 'LinkedIn: Data' });
  const shared = store.recordSighting({ url: 'https://www.linkedin.com/jobs/view/4425439971/', source: 'WhatsApp: Group A' });

  assert.equal(first.isNew, true);
  assert.equal(second.jobKey, first.jobKey);
  assert.equal(shared.jobKey, first.jobKey);
  const job = store.getJob(first.jobKey);
  assert.equal(job.canonical_url, 'https://www.linkedin.com/jobs/view/4425439971');
  assert.deepEqual(JSON.parse(job.sources_json), ['LinkedIn: Backend', 'LinkedIn: Data', 'WhatsApp: Group A']);
  store.close();
});

test('LinkedIn merges with a known job on company and role, like every other source', () => {
  const store = newStore();
  const ats = store.recordSighting({ url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Data Analyst', source: 'ATS: greenhouse-api' });
  const linkedin = store.recordSighting({ url: 'https://www.linkedin.com/jobs/view/4000000001', company: 'Acme Ltd', title: 'Data Analyst',
    source: 'LinkedIn: Analyst' });
  assert.equal(linkedin.jobKey, ats.jobKey);
  assert.equal(linkedin.isNew, false);
  const atsTwin = store.recordSighting({ url: 'https://jobs.lever.co/acme/2', company: 'Acme', title: 'Data Analyst', source: 'ATS: lever-api' });
  assert.equal(atsTwin.jobKey, ats.jobKey);
  assert.deepEqual(JSON.parse(store.getJob(ats.jobKey).sources_json), ['ATS: greenhouse-api', 'LinkedIn: Analyst', 'ATS: lever-api']);
  store.close();
});

test('an archived or rejected LinkedIn posting is not revived by a new sighting', () => {
  const store = newStore();
  const url = 'https://www.linkedin.com/jobs/view/4000000002';
  const archived = store.recordSighting({ url, company: 'Acme', title: 'Backend', source: 'LinkedIn: Backend' });
  store.archiveJob(archived.jobKey);
  const again = store.recordSighting({ url, company: 'Acme', title: 'Backend', source: 'LinkedIn: Backend' });
  assert.equal(again.isNew, false);
  assert.ok(store.getJob(archived.jobKey).archived_at);
  assert.equal(store.listPendingEvaluation().length, 0);
  store.close();
});

test('rejected LinkedIn postings keep only technical dedup identity', () => {
  const store = newStore();
  const sighting = store.recordSighting({ url: 'https://www.linkedin.com/jobs/view/4000000003', company: 'Acme', title: 'Backend',
    source: 'LinkedIn: Backend' });
  store.recordLinkedInPosting({ linkedinId: '4000000003', jobKey: sighting.jobKey, listedAt: '2026-09-28' });
  store.recordLinkedInExternalUrl('4000000003', 'https://boards.greenhouse.io/acme/jobs/9');
  store.saveEvaluation(sighting.jobKey, {
    company: 'Acme', title: 'Backend', summary: 's', score: 2, fitLabel: 'לא מתאים', decisionReason: 'r', suitable: false,
    applyUrl: 'https://www.linkedin.com/jobs/view/4000000003', activeStatus: 'active', contentHash: 'c', profileHash: 'p',
    criteriaVersion: 'v', evaluatedAt: 1,
  });
  const job = store.getJob(sighting.jobKey);
  assert.equal(job.company, null);
  assert.equal(job.sources_json, '[]');
  assert.equal(store.getLinkedInPosting('4000000003').external_canonical_url, null);
  assert.equal(store.getLinkedInPosting('4000000003').linkedin_id, '4000000003');
  store.close();
});

test('opening the store re-keys legacy LinkedIn URLs to the posting id without deleting collisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-store-'));
  const dbPath = path.join(dir, 'jobs.db');
  const store = createJobStore(dbPath);
  store.close();
  const raw = new Database(dbPath);
  const insert = raw.prepare(`INSERT INTO jobs (job_key, canonical_url, apply_url, company_role_key, sources_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, '::', '[]', 1, 1)`);
  insert.run('legacy1', 'https://il.linkedin.com/jobs/view/backend-at-acme-4100000001?refId=x', 'https://il.linkedin.com/jobs/view/backend-at-acme-4100000001');
  insert.run('legacy2', 'https://www.linkedin.com/jobs/view/4100000002', 'x');
  insert.run('legacy3', 'https://il.linkedin.com/jobs/view/4100000002?trackingId=y', 'y');
  raw.close();

  const reopened = createJobStore(dbPath);
  assert.equal(reopened.getJob('legacy1').canonical_url, 'https://www.linkedin.com/jobs/view/4100000001');
  assert.equal(reopened.getJob('legacy2').canonical_url, 'https://www.linkedin.com/jobs/view/4100000002');
  assert.equal(reopened.getJob('legacy3').canonical_url, 'https://il.linkedin.com/jobs/view/4100000002?trackingId=y');
  assert.equal(reopened.countJobs(), 3);
  reopened.close();
});

test('config/jobs.yml is the only source of LinkedIn searches and query changes restart coverage', () => {
  const store = newStore();
  store.syncLinkedInSearches([{ key: 'analyst', label: 'Analyst', keywords: '"data analyst"', location: 'Israel' }]);
  const [seeded] = store.listLinkedInSearches();
  store.recordLinkedInSearchAttempt({ searchId: seeded.id, queryHash: seeded.queryHash, status: 'complete', coveredUntil: 500 });

  const [relabeled] = store.syncLinkedInSearches([{ key: 'analyst', label: 'Analytics', keywords: '"Data  Analyst"', location: 'israel' }]);
  assert.equal(relabeled.label, 'Analytics');
  assert.equal(relabeled.coveredUntil, 500, 'a cosmetic config edit keeps coverage');
  const [changed] = store.syncLinkedInSearches([{ key: 'analyst', label: 'Analytics', keywords: '"data analyst" OR "bi analyst"', location: 'Israel' }]);
  assert.equal(changed.id, seeded.id);
  assert.equal(changed.coveredUntil, null, 'a changed query starts fresh');

  const afterRemoval = store.syncLinkedInSearches([{ key: 'backend', label: 'Backend', keywords: 'backend', location: 'Israel' }]);
  assert.deepEqual(afterRemoval.map(({ key, enabled }) => ({ key, enabled })), [
    { key: 'analyst', enabled: false },
    { key: 'backend', enabled: true },
  ], 'a search removed from config is disabled, not deleted');

  assert.throws(() => store.syncLinkedInSearches([{ key: 'x', keywords: 'x; DROP TABLE jobs', location: 'Israel' }]), /keywords/);
  assert.throws(() => store.syncLinkedInSearches([{ key: 'x', keywords: 'backend' }]), /location or geoId/);
  assert.throws(() => store.syncLinkedInSearches([{ keywords: 'backend', location: 'Israel' }]), /needs a key/);
  assert.throws(() => store.syncLinkedInSearches([
    { key: 'x', keywords: 'backend', location: 'Israel' }, { key: 'x', keywords: 'data', location: 'Israel' },
  ]), /unique/);
  assert.equal(store.isSourceEnabled('linkedin'), true);
  assert.equal(store.setSourceEnabled('linkedin', false), false);
  store.close();
});

test('a run that only fell short on LinkedIn still anchors the ATS/WhatsApp window', () => {
  const store = newStore();
  const runId = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats', 'whatsapp', 'linkedin'] });
  store.finishRun(runId, { status: 'incomplete', windowStatus: 'success', finishedAt: 10 });
  assert.equal(store.getLastSuccessfulRun(['ats', 'whatsapp'])?.id, runId);
  assert.equal(store.getLastSuccessfulRun(['ats', 'whatsapp', 'linkedin'])?.id, runId);
  const failed = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats', 'whatsapp', 'linkedin'] });
  store.finishRun(failed, { status: 'incomplete', windowStatus: 'incomplete', finishedAt: 20 });
  assert.equal(store.getLastSuccessfulRun(['ats', 'whatsapp'])?.id, runId);
  store.close();
});
