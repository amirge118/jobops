import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeSuitableResumeGaps } from '../scripts/jobs.mjs';
import { readCandidateContext } from '../scripts/jobs/config.mjs';
import { resumeGapInputHash } from '../scripts/jobs/core.mjs';
import { createResumeGapAnalyzer, RESUME_GAP_VERSION } from '../scripts/jobs/resume-gap.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

function createRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-resume-gap-'));
  fs.mkdirSync(path.join(rootDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'profile', '01-candidate-profile.md'), '# Profile\nBuilt APIs with Node.js and AWS.');
  fs.writeFileSync(path.join(rootDir, 'profile', '02-preferences.md'), '# Preferences\nBackend roles in Israel.');
  fs.writeFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), '# Current resume\nBackend engineer. Built Node.js services.');
  return rootDir;
}

function saveSuitableJob(store) {
  const sighting = store.recordSighting({
    url: 'https://example.com/jobs/1', company: 'Acme', title: 'Senior Backend Engineer',
    source: 'ats', seenAt: 100,
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Acme', title: 'Senior Backend Engineer', summary: 'Good backend role.',
    score: 4.4, fitLabel: 'מתאים', decisionReason: 'Strong fit.',
    fitBreakdown: { cvMatch: 4, seniority: 4, roleScope: 4, location: 5, sector: 4, uncertainties: [] },
    suitable: true, applyUrl: sighting.canonicalUrl, activeStatus: 'active',
    contentHash: 'content-v1', profileHash: 'profile-v1', criteriaVersion: 'v1', evaluatedAt: 200,
  });
  store.savePage({
    canonicalUrl: sighting.canonicalUrl,
    finalUrl: sighting.canonicalUrl,
    status: 'active',
    content: 'Required: Node.js and AWS.',
    contentHash: 'content-v1',
    fetchedAt: 150,
  });
  return sighting;
}

test('candidate context includes a private current-resume snapshot and stable hash', () => {
  const context = readCandidateContext({ rootDir: createRoot() });

  assert.equal(context.resumeAvailable, true);
  assert.match(context.currentResume, /Built Node\.js services/);
  assert.match(context.resumeHash, /^[a-f0-9]{64}$/);
});

test('resume gap analyzer requests only evidence-backed, actionable gaps', async () => {
  let prompt = '';
  const analyzer = createResumeGapAnalyzer({
    config: { rootDir: '/project', scoring: {} },
    runCodex: async (args) => {
      prompt = args.prompt;
      return { results: [{ jobKey: 'job-1', items: [
        {
          keyword: 'AWS', kind: 'safe_addition', importance: 'required',
          explanation: 'Required in the role and verified in the profile, but absent from the resume.',
          suggestion: 'Add AWS to the relevant backend experience bullet.',
          evidence: 'Built APIs with Node.js and AWS.',
        },
        {
          keyword: 'Kubernetes', kind: 'needs_confirmation', importance: 'preferred',
          explanation: 'Mentioned in the role, but no verified candidate evidence exists.',
          suggestion: 'Confirm real hands-on experience before adding it.', evidence: null,
        },
      ], employerPriorities: [
        { priority: 'Owning Node.js services end-to-end', weight: 'critical', coverage: 'strong', note: 'Clear in the resume.' },
        { priority: 'AWS production experience', weight: 'bogus', coverage: 'missing', note: 'In the profile only.' },
        { priority: '', weight: 'nice', coverage: 'missing', note: 'Dropped: empty priority.' },
      ], screenPass: { level: 'medium', reason: 'AWS is required but absent from the resume.' } }] };
    },
  });

  const result = await analyzer.analyze({
    job: {
      jobKey: 'job-1', company: 'Acme', title: 'Senior Backend Engineer', location: 'Tel Aviv',
      content: 'Required: Node.js and AWS. Kubernetes is preferred.',
    },
    profile: 'Built APIs with Node.js and AWS.',
    currentResume: 'Backend engineer. Built Node.js services.',
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].kind, 'safe_addition');
  assert.deepEqual(result.employerPriorities.map((item) => [item.weight, item.coverage]), [
    ['critical', 'strong'],
    ['important', 'missing'],
  ]);
  assert.deepEqual(result.screenPass, { level: 'medium', reason: 'AWS is required but absent from the resume.' });
  assert.match(prompt, /employerPriorities/);
  assert.match(prompt, /only the exact current resume/i);
  assert.match(prompt, /Never invent/i);
  assert.match(prompt, /exact current resume/i);
  assert.match(prompt, /maximum of 3/i);
  assert.equal(RESUME_GAP_VERSION.length > 0, true);
});

test('dashboard exposes cached resume gaps only while their input hash is current', () => {
  const rootDir = createRoot();
  const store = createJobStore(path.join(rootDir, 'data', 'jobs.db'));
  const job = saveSuitableJob(store);
  const inputHash = resumeGapInputHash({
    contentHash: 'content-v1', profileHash: 'profile-v1', resumeHash: 'resume-v1',
    analysisVersion: RESUME_GAP_VERSION,
  });
  store.saveResumeGap(job.jobKey, {
    inputHash,
    analysis: { items: [{
      keyword: 'AWS', kind: 'safe_addition', importance: 'required',
      explanation: 'Verified but missing.', suggestion: 'Add it to the relevant bullet.',
      evidence: 'Built APIs on AWS.',
    }],
    employerPriorities: [{ priority: 'AWS', weight: 'critical', coverage: 'missing', note: 'Profile only.' }],
    screenPass: { level: 'low', reason: 'Missing AWS.' } },
    analyzedAt: 300,
  });

  const current = store.listDashboardJobs({ resumeGapContext: {
    profileHash: 'profile-v1', resumeHash: 'resume-v1',
    analysisVersion: RESUME_GAP_VERSION, resumeAvailable: true,
  } });
  assert.equal(current[0].resumeGap.status, 'ready');
  assert.equal(current[0].resumeGap.items[0].keyword, 'AWS');
  assert.equal(current[0].resumeGap.employerPriorities[0].weight, 'critical');
  assert.equal(current[0].resumeGap.screenPass.level, 'low');

  const stale = store.listDashboardJobs({ resumeGapContext: {
    profileHash: 'profile-v1', resumeHash: 'resume-v2',
    analysisVersion: RESUME_GAP_VERSION, resumeAvailable: true,
  } });
  assert.equal(stale[0].resumeGap.status, 'pending');
  assert.deepEqual(stale[0].resumeGap.items, []);
  store.close();
});

test('resume analysis stage persists results without changing the job decision', async () => {
  const rootDir = createRoot();
  const store = createJobStore(path.join(rootDir, 'data', 'jobs.db'));
  saveSuitableJob(store);
  const candidateContext = {
    profile: 'Built APIs with Node.js and AWS.',
    currentResume: 'Backend engineer. Built Node.js services.',
    profileHash: 'profile-v1',
    resumeHash: 'resume-v1',
    resumeAvailable: true,
  };
  const analyzer = {
    version: RESUME_GAP_VERSION,
    async analyzeBatchSettled(jobs, { onProgress }) {
      const results = jobs.map((job) => ({
        jobKey: job.jobKey,
        items: [{
          keyword: 'AWS', kind: 'safe_addition', importance: 'required',
          explanation: 'Verified but missing.', suggestion: 'Add it to the relevant bullet.',
          evidence: 'Built APIs on AWS.',
        }],
        employerPriorities: [{ priority: 'Node.js at scale', weight: 'critical', coverage: 'strong', note: 'In the resume.' }],
        screenPass: { level: 'high', reason: 'Core stack is visible.' },
      }));
      onProgress({ completed: jobs.length, total: jobs.length, failed: 0, results, failures: [] });
      return { results, failures: [] };
    },
  };

  const summary = await analyzeSuitableResumeGaps({
    config: {}, store, analyzer, candidateContext,
  });

  assert.deepEqual(summary, { status: 'complete', analyzed: 1, failed: 0 });
  assert.equal(store.getDashboardStats().suitable, 1);
  const [listed] = store.listDashboardJobs({ resumeGapContext: {
    profileHash: 'profile-v1', resumeHash: 'resume-v1',
    analysisVersion: RESUME_GAP_VERSION, resumeAvailable: true,
  } });
  assert.equal(listed.resumeGap.status, 'ready');
  assert.equal(listed.resumeGap.employerPriorities[0].priority, 'Node.js at scale');
  assert.deepEqual(listed.resumeGap.screenPass, { level: 'high', reason: 'Core stack is visible.' });
  store.close();
});
