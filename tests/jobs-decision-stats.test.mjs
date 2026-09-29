import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDecisionStats } from '../scripts/jobs/decision-stats.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const DAY = 24 * 60 * 60 * 1_000;

function tempStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-decisions-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createJobStore(path.join(dir, 'jobs.db'));
}

function saveSuitable(store, { url, company = 'Acme', title = 'Backend Engineer', score = 4.2, source = 'WhatsApp: Jobs' }) {
  const sighting = store.recordSighting({ url, company, title, source, seenAt: 1_000 });
  store.saveEvaluation(sighting.jobKey, {
    company, title, summary: 'Backend work.', score, fitLabel: 'מתאים', decisionReason: 'Fits.',
    fitBreakdown: {
      cvMatch: 4, seniority: 5, roleScope: 4, location: 5, sector: 3,
      evidence: { cvMatch: 'long page-derived text' }, uncertainties: ['x'],
    },
    suitable: true, applyUrl: url, activeStatus: 'active', contentHash: 'c1',
    profileHash: 'p1', criteriaVersion: 'anchored-v4-evidence', evaluatedAt: 2_000,
  });
  return sighting.jobKey;
}

test('a decision keeps a minimal snapshot, archives the job, and still deduplicates it', (context) => {
  const store = tempStore(context);
  const jobKey = saveSuitable(store, { url: 'https://example.com/jobs/1' });

  assert.equal(store.decideJob(jobKey, 'too_senior', 5_000), true);

  const [decision] = store.listJobDecisions();
  assert.equal(decision.decision, 'too_senior');
  assert.equal(decision.decidedAt, 5_000);
  assert.equal(decision.company, 'Acme');
  assert.equal(decision.score, 4.2);
  assert.deepEqual(decision.fit, { cvMatch: 4, seniority: 5, roleScope: 4, location: 5, sector: 3 },
    'only the numeric dimensions are kept — no evidence or uncertainty text');
  assert.deepEqual(decision.sourceKinds, ['whatsapp']);
  assert.equal(decision.criteriaVersion, 'anchored-v4-evidence');

  const job = store.getJob(jobKey);
  assert.ok(job.archived_at);
  assert.equal(job.company, null, 'the job itself is still wiped by archiving');
  assert.equal(store.getDashboardStats().suitable, 0);

  const again = store.recordSighting({ url: 'https://example.com/jobs/1', company: 'Acme', title: 'Backend Engineer', source: 'ATS: x' });
  assert.equal(again.isNew, false);
  assert.equal(store.decideJob(jobKey, 'interested'), false, 'a decided job cannot be decided twice');
  assert.equal(store.listJobDecisions().length, 1);
  store.close();
});

test('an unknown decision is rejected without archiving anything', (context) => {
  const store = tempStore(context);
  const jobKey = saveSuitable(store, { url: 'https://example.com/jobs/2' });
  assert.throws(() => store.decideJob(jobKey, 'archive'), /Unknown decision/);
  assert.equal(store.getJob(jobKey).archived_at, null);
  assert.equal(store.listJobDecisions().length, 0);
  assert.equal(store.decideJob('aaaaaaaaaaaaaaaaaaaaaaaa', 'interested'), false);
  store.close();
});

function decision(overrides) {
  return {
    jobKey: overrides.jobKey || Math.random().toString(16).slice(2),
    decision: 'interested', decidedAt: 0, company: 'Acme', title: 'Backend', applyUrl: 'https://example.com/j',
    score: 4.2, fit: { cvMatch: 4, seniority: 4, roleScope: 4, location: 5, sector: 3 }, sourceKinds: ['ats'],
    ...overrides,
  };
}

test('decision stats split windows, score bands, sources, and calibration signals', () => {
  const now = 100 * DAY;
  const stats = buildDecisionStats([
    decision({ decision: 'interested', decidedAt: now - DAY, score: 3.7, sourceKinds: ['whatsapp'] }),
    decision({ decision: 'too_senior', decidedAt: now - 2 * DAY, score: 4.6, fit: { seniority: 5 } }),
    decision({ decision: 'too_senior', decidedAt: now - 20 * DAY, score: 4.1, fit: { seniority: 2 } }),
    decision({ decision: 'not_relevant', decidedAt: now - 40 * DAY, score: 3.8, fit: { roleScope: 4, cvMatch: 3 }, sourceKinds: [] }),
    decision({ decision: 'company_not_interesting', decidedAt: now - 3 * DAY, company: 'Bigcorp', score: 4.2 }),
    decision({ decision: 'company_not_interesting', decidedAt: now - 4 * DAY, company: 'Bigcorp', score: 4.3 }),
    decision({ decision: 'company_candidate', decidedAt: now - 5 * DAY, score: 4.9, sourceKinds: ['linkedin', 'ats'] }),
  ], { now, pending: 6, minimumScore: 3.6, exactMatchScore: 4.5 });

  assert.equal(stats.pending, 6);
  assert.equal(stats.windows['7d'].total, 5);
  assert.equal(stats.windows['7d'].positive, 2);
  assert.equal(stats.windows['30d'].byDecision.too_senior, 2);
  assert.equal(stats.windows.all.total, 7);

  assert.deepEqual(stats.scoreBands.map(({ key, from, to, total, positive }) => ({ key, from, to, total, positive })), [
    { key: 'trial', from: 3.6, to: 4, total: 2, positive: 1 },
    { key: 'fit', from: 4, to: 4.5, total: 3, positive: 0 },
    { key: 'exact', from: 4.5, to: null, total: 2, positive: 1 },
  ]);

  assert.deepEqual(stats.sources.find((row) => row.key === 'ats'), { key: 'ats', total: 5, positive: 1 });
  assert.deepEqual(stats.sources.find((row) => row.key === 'unknown'), { key: 'unknown', total: 1, positive: 0 });

  assert.deepEqual(stats.calibration, {
    tooSeniorDespiteFit: 1, tooSeniorTotal: 2,
    notRelevantDespiteFit: 1, notRelevantTotal: 1,
    positiveBelowLegacy: 1, totalBelowLegacy: 2,
  });
  assert.deepEqual(stats.rejectedCompanies, [{ company: 'Bigcorp', count: 2 }]);

  assert.equal(stats.recent[0].decision, 'interested');
  assert.equal(stats.recent[0].applyUrl, 'https://example.com/j');
  assert.equal(stats.recent.find((item) => item.decision === 'too_senior').applyUrl, null);
});

test('without a lowered threshold there is no trial band', () => {
  const stats = buildDecisionStats([], { minimumScore: 4, exactMatchScore: 4.5 });
  assert.deepEqual(stats.scoreBands.map((band) => band.key), ['fit', 'exact']);
  assert.equal(stats.windows.all.total, 0);
  assert.deepEqual(stats.recent, []);
});

test('decisions made under a lower threshold stay in the trial band after it is raised', () => {
  const stats = buildDecisionStats([decision({ score: 3.7 })], { minimumScore: 4, exactMatchScore: 4.5 });
  assert.deepEqual(stats.scoreBands[0], { key: 'trial', from: 3.7, to: 4, total: 1, positive: 1, byDecision: stats.scoreBands[0].byDecision });
});
