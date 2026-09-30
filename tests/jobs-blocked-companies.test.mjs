import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { createJobStore } from '../scripts/jobs/store.mjs';
import { evaluateCandidates } from '../scripts/jobs.mjs';
import { buildNegativeTitleFilter, buildTitleFilter, loadTitleFilterNegative, loadTitleFilterPositive } from '../scripts/scan.mjs';

function temporaryDb(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-blocked-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'jobs.db');
}

function suitableJob(store, { url, company, title = 'Backend Engineer', source = 'ATS: greenhouse-api' }) {
  const sighting = store.recordSighting({ url, company, title, source });
  store.saveEvaluation(sighting.jobKey, {
    company, title, summary: 's', score: 4.2, fitLabel: 'מתאים', decisionReason: 'r', suitable: true,
    applyUrl: url, activeStatus: 'active', contentHash: 'c', profileHash: 'p1', criteriaVersion: 'v1', evaluatedAt: 1,
  });
  return sighting.jobKey;
}

const scorerCounting = (calls) => ({
  profileHash: 'p1',
  scoreBatchSettled: async (items, { onProgress }) => {
    calls.push(...items.map((item) => item.candidate.jobKey));
    onProgress({ completed: items.length, total: items.length, failed: 0, results: [], failures: [] });
  },
});

test('"company not interesting" blocks that company from now on; other decisions do not', (context) => {
  const store = createJobStore(temporaryDb(context));
  context.after(() => store.close());
  const blocked = suitableJob(store, { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme Ltd' });
  const liked = suitableJob(store, { url: 'https://boards.greenhouse.io/beta/jobs/1', company: 'Beta' });

  assert.equal(store.decideJob(blocked, 'company_not_interesting'), true);
  assert.equal(store.decideJob(liked, 'not_relevant'), true);
  assert.equal(store.isCompanyBlocked('Acme Technologies'), true, 'matched on the same normalized company key');
  assert.equal(store.isCompanyBlocked('Beta'), false);
  assert.equal(store.isCompanyBlocked(''), false);
});

test('decisions made before the block existed are not backfilled', (context) => {
  const dbPath = temporaryDb(context);
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE job_decisions (job_key TEXT PRIMARY KEY, decision TEXT NOT NULL, decided_at INTEGER NOT NULL,
    company TEXT, title TEXT, apply_url TEXT, score REAL, fit_label TEXT, fit_json TEXT,
    source_kinds_json TEXT NOT NULL DEFAULT '[]', screen_pass TEXT, criteria_version TEXT, first_seen_at INTEGER)`);
  raw.prepare("INSERT INTO job_decisions (job_key, decision, decided_at, company) VALUES ('old', 'company_not_interesting', 1, 'Palo Alto Networks')").run();
  raw.close();
  const store = createJobStore(dbPath);
  context.after(() => store.close());
  assert.equal(store.isCompanyBlocked('Palo Alto Networks'), false);
});

test('a blocked company is rejected before fetch when listed, and before scoring when only its page names it', async (context) => {
  const store = createJobStore(temporaryDb(context));
  context.after(() => store.close());
  store.decideJob(suitableJob(store, { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme' }), 'company_not_interesting');

  const listed = { ...store.recordSighting({ url: 'https://boards.greenhouse.io/acme/jobs/2', company: 'Acme', title: 'Platform Engineer', source: 'ATS: greenhouse-api' }),
    url: 'https://boards.greenhouse.io/acme/jobs/2', company: 'Acme', title: 'Platform Engineer', source: 'ATS: greenhouse-api' };
  const shared = { ...store.recordSighting({ url: 'https://hiremetech.com/job/9', source: 'WhatsApp: Group A' }),
    url: 'https://hiremetech.com/job/9', source: 'WhatsApp: Group A' };
  const other = { ...store.recordSighting({ url: 'https://hiremetech.com/job/10', source: 'WhatsApp: Group A' }),
    url: 'https://hiremetech.com/job/10', source: 'WhatsApp: Group A' };
  const fetched = [];
  const scored = [];

  const outcomes = await evaluateCandidates({
    candidates: [listed, shared, other], store,
    config: { decision: { criteriaVersion: 'v1' } },
    fetcher: {
      fetch: async (url) => {
        fetched.push(url);
        const company = url.endsWith('/9') ? 'Acme Ltd' : 'Gamma';
        return { status: 'active', finalUrl: url, contentHash: url, content: `Title: Backend Engineer\nCompany: ${company}`,
          identity: { company, title: 'Backend Engineer' } };
      },
    },
    scorer: scorerCounting(scored),
  });

  assert.equal(fetched.includes(listed.url), false, 'a listed blocked company is never fetched');
  assert.equal(outcomes.get(listed.jobKey).status, 'filtered');
  assert.equal(outcomes.get(shared.jobKey).status, 'filtered');
  assert.deepEqual(scored, [other.jobKey]);
  assert.equal(store.getJob(shared.jobKey).suitable, 0);
});

test('data roles are filtered out by title, backend roles still pass', () => {
  const portals = path.join(process.cwd(), 'portals.yml');
  const passesNegative = buildNegativeTitleFilter(loadTitleFilterNegative(portals));
  const passesAts = buildTitleFilter({ ...loadTitleFilterPositive(portals), negative: loadTitleFilterNegative(portals) });
  for (const title of ['Senior Data Engineer', 'Data Engineer – Applied ML', 'Data Analyst', 'Data Developer', 'Analytics Engineer', 'BI Developer']) {
    assert.equal(passesNegative(title), false, title);
    assert.equal(passesAts(title), false, title);
  }
  for (const title of ['Senior Backend Engineer', 'Senior Machine Learning Engineer', 'Forward Deployed Engineer']) {
    assert.equal(passesAts(title), true, title);
  }
});
