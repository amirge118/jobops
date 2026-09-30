import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { deduplicateJobs, isPlaceholderIdentity, normalizeCompanyRole } from '../scripts/jobs/core.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { evaluateCandidates } from '../scripts/jobs.mjs';

function temporaryDb(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-dedup-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'jobs.db');
}

function newStore(context) {
  const store = createJobStore(temporaryDb(context));
  context.after(() => store.close());
  return store;
}

function evaluation(overrides = {}) {
  return {
    company: 'Acme', title: 'Backend Engineer', summary: 's', score: 4.2, fitLabel: 'מתאים', decisionReason: 'r',
    suitable: true, applyUrl: 'https://example.com/apply', activeStatus: 'active', contentHash: 'c',
    profileHash: 'p1', criteriaVersion: 'v1', evaluatedAt: 1_000,
    ...overrides,
  };
}

function whatsAppJob(store, url, seenAt = 500) {
  return { ...store.recordSighting({ url, source: 'WhatsApp: Group A', seenAt }), url, source: 'WhatsApp: Group A' };
}

test('company keys ignore legal and generic suffixes; titles only expand sr/jr', () => {
  assert.equal(
    normalizeCompanyRole('Check Point Software Technologies Ltd.', 'Backend Developer'),
    normalizeCompanyRole('Check Point', 'Backend Developer'),
  );
  assert.equal(normalizeCompanyRole('Fetcherr.ai', 'Sr. System Architect'), 'fetcherr::senior system architect');
  assert.equal(normalizeCompanyRole('Wix.com Ltd', 'Backend Engineer'), 'wix::backend engineer');
  // A name made only of a suffix word is never stripped to nothing.
  assert.equal(normalizeCompanyRole('Software', 'QA'), 'software::qa');
  // Different titles stay different: no fuzzy matching.
  assert.notEqual(normalizeCompanyRole('Acme', 'Senior Backend Engineer'), normalizeCompanyRole('Acme', 'Staff Backend Engineer'));
});

test('placeholder identities never form a key', () => {
  assert.equal(normalizeCompanyRole('חברה לא ידועה', 'משרה לא ידועה'), '::');
  assert.equal(normalizeCompanyRole('Nebius', 'משרה לא מזוהה'), '::');
  assert.equal(normalizeCompanyRole('Unknown', 'Generative AI Engineer'), '::');
  assert.equal(isPlaceholderIdentity('Acme', ''), true);
  assert.equal(isPlaceholderIdentity('Acme', 'Backend'), false);
  const jobs = [
    { company: 'Unknown', title: 'Role', applyUrl: 'https://a.example/1' },
    { company: 'Unknown', title: 'Role', applyUrl: 'https://b.example/2' },
  ];
  assert.equal(deduplicateJobs(jobs).length, 2);
});

test('a WhatsApp link whose page names an already-scored job is never sent to the scorer', async (context) => {
  const store = newStore(context);
  const ats = store.recordSighting({ url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Backend Engineer', source: 'ATS: greenhouse-api', seenAt: 100 });
  store.saveEvaluation(ats.jobKey, evaluation());
  const candidate = whatsAppJob(store, 'https://hiremetech.com/job/555');
  let scoreCalls = 0;

  const outcomes = await evaluateCandidates({
    candidates: [candidate], store,
    config: { decision: { criteriaVersion: 'v1' }, rootDir: process.cwd() },
    fetcher: {
      fetch: async (url) => ({
        status: 'active', finalUrl: url, contentHash: 'h',
        content: 'Title: Backend Engineer\nCompany: Acme Ltd\nDescription: Backend Engineer role',
        identity: { company: 'Acme Ltd', title: 'Backend Engineer' },
      }),
    },
    scorer: {
      profileHash: 'p1',
      scoreBatchSettled: async (items, { onProgress }) => {
        scoreCalls += items.length;
        onProgress({ completed: items.length, total: items.length, failed: 0, results: [], failures: [] });
      },
    },
  });

  assert.equal(scoreCalls, 0);
  assert.equal(outcomes.get(candidate.jobKey).status, 'duplicate');
  assert.equal(store.getJob(candidate.jobKey).duplicate_of, ats.jobKey);
  assert.deepEqual(JSON.parse(store.getJob(ats.jobKey).sources_json), ['ATS: greenhouse-api', 'WhatsApp: Group A']);
  assert.equal(store.listPendingEvaluation().length, 0);
  assert.deepEqual(store.listDashboardJobs().map((job) => job.jobKey), [ats.jobKey]);

  // The next sighting of the duplicate URL lands on the representative.
  const again = store.recordSighting({ url: 'https://hiremetech.com/job/555', source: 'WhatsApp: Group B' });
  assert.equal(again.jobKey, ats.jobKey);
  assert.equal(again.isNew, false);
});

test('two links to one job in the same run: the second waits on the first instead of being scored', async (context) => {
  const store = newStore(context);
  const first = whatsAppJob(store, 'https://example.com/jobs/a');
  const second = whatsAppJob(store, 'https://other.example/careers/b');
  let scored = [];

  await evaluateCandidates({
    candidates: [first, second], store,
    config: { decision: { criteriaVersion: 'v1' }, rootDir: process.cwd() },
    fetcher: {
      fetch: async (url) => ({
        status: 'active', finalUrl: url, contentHash: url,
        content: 'Backend Engineer at Acme, apply now.',
        identity: { company: 'Acme', title: 'Backend Engineer' },
      }),
    },
    scorer: {
      profileHash: 'p1',
      scoreBatchSettled: async (items, { onProgress }) => {
        scored = items.map((item) => item.candidate.jobKey);
        onProgress({ completed: items.length, total: items.length, failed: 0, results: [], failures: [] });
      },
    },
  });

  assert.deepEqual(scored, [first.jobKey]);
  assert.equal(store.getJob(second.jobKey).duplicate_of, first.jobKey);
});

test('a twin revealed only by scoring is merged after the fact and hidden from the dashboard', (context) => {
  const store = newStore(context);
  const first = whatsAppJob(store, 'https://example.com/jobs/a', 100);
  const second = whatsAppJob(store, 'https://example.com/jobs/b', 200);
  store.saveEvaluation(first.jobKey, evaluation({ applyUrl: 'https://example.com/jobs/a' }));
  store.saveEvaluation(second.jobKey, evaluation({ applyUrl: 'https://example.com/jobs/b', evaluatedAt: 2_000 }));

  assert.equal(store.getJob(second.jobKey).duplicate_of, first.jobKey);
  assert.deepEqual(store.listDashboardJobs().map((job) => job.jobKey), [first.jobKey]);
  assert.equal(store.getDashboardStats().total, 1);
});

test('a fresh verdict replaces a twin decided under an older profile', (context) => {
  const store = newStore(context);
  const old = whatsAppJob(store, 'https://example.com/jobs/old', 100);
  const fresh = whatsAppJob(store, 'https://example.com/jobs/new', 200);
  store.saveEvaluation(old.jobKey, evaluation({ profileHash: 'old-profile' }));
  store.saveEvaluation(fresh.jobKey, evaluation({ profileHash: 'p1', evaluatedAt: 2_000 }));

  assert.equal(store.getJob(old.jobKey).duplicate_of, fresh.jobKey);
  assert.equal(store.getJob(fresh.jobKey).duplicate_of, null);
});

test('a dead link never hides a live twin', (context) => {
  const store = newStore(context);
  const live = whatsAppJob(store, 'https://example.com/jobs/live', 100);
  const dead = whatsAppJob(store, 'https://example.com/jobs/dead', 200);
  store.saveEvaluation(live.jobKey, evaluation({ profileHash: 'old-profile' }));
  store.saveEvaluation(dead.jobKey, evaluation({ suitable: false, activeStatus: 'expired', evaluatedAt: 2_000 }));

  assert.equal(store.getJob(live.jobKey).duplicate_of, null);
  assert.equal(store.getJob(dead.jobKey).duplicate_of, live.jobKey);
});

test('jobs with placeholder identities are never merged with each other', (context) => {
  const store = newStore(context);
  const first = whatsAppJob(store, 'https://example.com/jobs/1');
  const second = whatsAppJob(store, 'https://example.com/jobs/2');
  const placeholder = { company: 'חברה לא ידועה', title: 'משרה לא ידועה', suitable: false, activeStatus: 'expired' };
  store.saveEvaluation(first.jobKey, evaluation(placeholder));
  store.saveEvaluation(second.jobKey, evaluation(placeholder));
  assert.equal(store.getJob(first.jobKey).duplicate_of, null);
  assert.equal(store.getJob(second.jobKey).duplicate_of, null);
  assert.equal(store.getJob(first.jobKey).company_role_key, '::');
});

test('claiming an identity already queued marks the later job as its duplicate; placeholders are not claimed', (context) => {
  const store = newStore(context);
  const keep = whatsAppJob(store, 'https://example.com/jobs/keep', 100);
  const merged = whatsAppJob(store, 'https://example.com/jobs/merged', 200);
  store.claimJobIdentity(keep.jobKey, { company: 'Acme', title: 'Backend Engineer', profileHash: 'p1', criteriaVersion: 'v1' });
  const result = store.claimJobIdentity(merged.jobKey, { company: 'Acme', title: 'Backend Engineer', profileHash: 'p1', criteriaVersion: 'v1' });
  assert.equal(result.duplicateOf, keep.jobKey);
  // Placeholder identities are not claimed.
  const other = whatsAppJob(store, 'https://example.com/jobs/other');
  assert.deepEqual(store.claimJobIdentity(other.jobKey, { company: '', title: 'Backend' }), { duplicateOf: null });
});

test('the one-off cleanup re-keys legacy rows and merges each group into one representative', (context) => {
  const dbPath = temporaryDb(context);
  const store = createJobStore(dbPath);
  context.after(() => store.close());
  const suitable = whatsAppJob(store, 'https://www.linkedin.com/jobs/view/4471276925', 300);
  store.saveEvaluation(suitable.jobKey, evaluation({ company: 'Check Point Software', title: 'Backend Software Developer' }));
  const rejected = whatsAppJob(store, 'https://www.linkedin.com/jobs/view/4473244633', 100);
  const unknownA = whatsAppJob(store, 'https://example.com/jobs/u1', 50);
  const unknownB = whatsAppJob(store, 'https://example.com/jobs/u2', 60);

  // Rows as the previous version stored them: a rejected row keeps only its
  // (old-format) key, and dead links share the placeholder key.
  const raw = new Database(dbPath);
  raw.prepare(`UPDATE jobs SET company_role_key = ?, evaluated_at = 1, suitable = 0 WHERE job_key = ?`)
    .run('check point software technologies::backend software developer', rejected.jobKey);
  raw.prepare(`UPDATE jobs SET company_role_key = ?, evaluated_at = 1, suitable = 0 WHERE job_key IN (?, ?)`)
    .run('חברה לא ידועה::משרה לא ידועה', unknownA.jobKey, unknownB.jobKey);
  raw.close();

  const plan = store.planIdentityDedup();
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].representative.job_key, suitable.jobKey);
  assert.deepEqual(plan.groups[0].duplicates.map((row) => row.job_key), [rejected.jobKey]);
  assert.equal(store.getJob(rejected.jobKey).duplicate_of, null, 'planning alone writes nothing');

  const result = store.applyIdentityDedup();
  assert.deepEqual({ groups: result.groups, duplicates: result.duplicates }, { groups: 1, duplicates: 1 });
  assert.equal(store.getJob(rejected.jobKey).duplicate_of, suitable.jobKey);
  assert.equal(store.getJob(unknownA.jobKey).duplicate_of, null);
  assert.equal(store.getJob(unknownA.jobKey).company_role_key, '::');
  assert.equal(store.planIdentityDedup().groups.length, 0, 'a second run finds nothing');
});
