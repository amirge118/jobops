import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceScanStatRows } from '../scripts/jobs.mjs';
import { buildSourceValue } from '../scripts/jobs/source-value.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const DAY = 24 * 60 * 60 * 1_000;

function tempStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-source-value-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createJobStore(path.join(dir, 'jobs.db'));
}

function evaluation(overrides = {}) {
  return {
    company: 'Acme', title: 'Backend Engineer', summary: 's', score: 4.2, fitLabel: 'מתאים',
    decisionReason: 'r', suitable: true, applyUrl: 'https://acme.com/jobs/1', activeStatus: 'active',
    contentHash: 'c', profileHash: 'p', criteriaVersion: 'v', evaluatedAt: 5_000, scoredByModel: true,
    ...overrides,
  };
}

test('source sightings and outcome timestamps survive archiving', (context) => {
  const store = tempStore(context);
  const ats = store.recordSighting({ url: 'https://acme.com/jobs/1', company: 'Acme', title: 'Backend Engineer', source: 'ATS: greenhouse-api', seenAt: 1_000 });
  store.recordSighting({ url: 'https://chat.example/x', company: 'Acme', title: 'Backend Engineer', source: 'WhatsApp: Group', seenAt: 3_000 });
  store.recordSighting({ url: 'https://acme.com/jobs/1', company: 'Acme', title: 'Backend Engineer', source: 'ATS: greenhouse-api', seenAt: 9_000 });
  store.saveEvaluation(ats.jobKey, evaluation());
  store.decideJob(ats.jobKey, 'interested', 6_000);

  const facts = store.listSourceValueFacts();
  const rows = facts.sightings.filter((row) => row.jobKey === ats.jobKey);
  assert.deepEqual(rows.map(({ source, firstSeenAt, company }) => ({ source, firstSeenAt, company })).sort((a, b) => a.firstSeenAt - b.firstSeenAt), [
    { source: 'ats', firstSeenAt: 1_000, company: 'Acme' },
    { source: 'whatsapp', firstSeenAt: 3_000, company: 'Acme' },
  ], 'first sighting per source only');
  assert.ok(rows.every((row) => row.firstScoredAt === 5_000 && row.firstSuitableAt === 5_000 && row.decision === 'interested'),
    'archiving wipes content but not the outcome timestamps');
  store.close();
});

test('local verdicts are not counted as model scoring', (context) => {
  const store = tempStore(context);
  const sighting = store.recordSighting({ url: 'https://acme.com/jobs/2', company: 'Acme', title: 'Frontend', source: 'ATS: x', seenAt: 1_000 });
  store.saveEvaluation(sighting.jobKey, evaluation({ suitable: false, scoredByModel: false, score: 1 }));
  assert.equal(store.getJob(sighting.jobKey).first_scored_at, null);
  assert.equal(store.getJob(sighting.jobKey).first_suitable_at, null);
  store.close();
});

test('each collected source gets one scan-stats row with its processing outcome', (context) => {
  const rows = sourceScanStatRows({
    ats: { found: 2229, candidates: 23, errors: 3, filtered: { title: 2017, location: 107, recency: 82 } },
    whatsapp: { candidates: 49 },
    linkedin: null,
    processing: { scopes: [
      { source: 'ats', processed: 3, suitable: 1, failed: 15 },
      { source: 'whatsapp', processed: 12, suitable: 0, failed: 33 },
      { source: 'whatsapp', processed: 4, suitable: 2, failed: 0 },
    ] },
  }, { ats: 11.2, whatsapp: 40 });
  assert.deepEqual(rows, [
    { source: 'ats', seconds: 11.2, found: 2229, candidates: 23, errors: 3, filteredTitle: 2017, filteredLocation: 107, filteredRecency: 82, scored: 3, suitable: 1, failed: 15 },
    { source: 'whatsapp', seconds: 40, found: 49, candidates: 49, errors: 0, scored: 16, suitable: 2, failed: 33 },
  ]);

  const store = tempStore(context);
  store.recordSourceScanStats(rows, { runId: 7, at: 10_000 });
  const [ats] = store.listSourceValueFacts().scans;
  assert.equal(ats.source, 'ats');
  assert.equal(ats.filteredTitle, 2017);
  assert.equal(ats.seconds, 11.2);
  store.close();
});

test('source value reports yield, company productivity, and exclusivity with lead time', () => {
  const now = 100 * DAY;
  const at = (days) => now - days * DAY;
  const value = buildSourceValue({
    scans: [
      { source: 'ats', scannedAt: at(2), seconds: 10, found: 800, filteredTitle: 600, filteredLocation: 150, filteredRecency: 0, candidates: 50 },
      { source: 'ats', scannedAt: at(1), seconds: 12, found: 810, filteredTitle: 610, filteredLocation: 150, filteredRecency: 0, candidates: 50 },
      { source: 'whatsapp', scannedAt: at(1), seconds: 60, found: 40, filteredTitle: 0, filteredLocation: 0, filteredRecency: 0, candidates: 40 },
      { source: 'ats', scannedAt: at(45), seconds: 99, found: 1, filteredTitle: 0, filteredLocation: 0, filteredRecency: 0, candidates: 1 },
    ],
    sightings: [
      // ATS-only fit at Lemonade, decided interesting.
      { jobKey: 'a', source: 'ats', company: 'Lemonade', firstSeenAt: at(5), firstScoredAt: at(5), firstSuitableAt: at(5), decision: 'interested' },
      // Found by ATS 3 days before WhatsApp.
      { jobKey: 'b', source: 'ats', company: 'Wiz', firstSeenAt: at(6), firstScoredAt: at(6), firstSuitableAt: at(6), decision: null },
      { jobKey: 'b', source: 'whatsapp', company: null, firstSeenAt: at(3), firstScoredAt: at(6), firstSuitableAt: at(6), decision: null },
      // ATS candidate that did not fit.
      { jobKey: 'c', source: 'ats', company: 'Wiz', firstSeenAt: at(4), firstScoredAt: at(4), firstSuitableAt: null, decision: null },
      // WhatsApp-only fit.
      { jobKey: 'd', source: 'whatsapp', company: null, firstSeenAt: at(2), firstScoredAt: at(2), firstSuitableAt: at(2), decision: null },
    ],
    watchedCompanies: ['Lemonade', 'Wiz', 'Gong', 'Monday'],
  }, { now, windowDays: 30 });

  const ats = value.yield.find((row) => row.source === 'ats');
  assert.deepEqual(ats, {
    source: 'ats', scans: 2, medianScanSeconds: 11, found: 1610, filtered: 1510, newJobs: 3, scored: 3,
    suitable: 2, interested: 1, suitablePerScan: 1, scoredPerSuitable: 1.5,
  });
  assert.equal(value.totalFits, 3);
  assert.deepEqual({ ...value.companies, top: value.companies.top.map((row) => row.company) }, {
    watched: 4, withCandidates: 2, withSuitable: 2, silent: 2, topShare: 1, top: ['Wiz', 'Lemonade'],
  });
  assert.deepEqual(value.exclusivity.find((row) => row.source === 'ats'), { source: 'ats', fits: 2, exclusive: 1, shared: 1, medianLeadDays: 3 });
  assert.deepEqual(value.exclusivity.find((row) => row.source === 'whatsapp'), { source: 'whatsapp', fits: 2, exclusive: 1, shared: 1, medianLeadDays: -3 });
});
