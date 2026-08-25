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
