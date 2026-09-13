import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  store.queueWhatsAppMessage({ messageId: 'failed', groupJid: 'group-a@g.us', timestamp: 3_000, text: 'private failed' });
  store.markMessageFailed({ messageId: 'failed', groupJid: 'group-a@g.us', error: 'temporary' });

  const stats = store.getWhatsAppGroupCollectionStats('group-a@g.us');
  assert.deepEqual(stats, {
    totalCollected: 3,
    pending: 2,
    failed: 1,
    lastCollectedAt: 3_000,
    lastProcessedAt: 1_000,
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
    ['jobKey', 'company', 'title', 'summary', 'score', 'fitLabel', 'decisionReason', 'applyUrl', 'suitable', 'activeStatus', 'lastSeenAt', 'openedAt', 'fitBreakdown'],
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
