import './helpers/stdout-safe-console.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { evaluateCandidates } from '../scripts/jobs.mjs';
import { extractLinkHint } from '../scripts/jobs/sources/whatsapp.mjs';

function tempStore(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-hint-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  return store;
}

test('a link hint comes from the URL slug, else a bold first line, else the text before the link', () => {
  assert.deepEqual(
    extractLinkHint('look at this', 'https://il.linkedin.com/jobs/view/senior-data-analyst-at-acme-ltd-4458840528?refId=x'),
    { source: 'slug', title: 'senior data analyst', company: 'acme ltd' },
  );
  assert.deepEqual(
    extractLinkHint('*Backend Engineer*\n\nApply: https://www.linkedin.com/jobs/view/4458840528', 'https://www.linkedin.com/jobs/view/4458840528'),
    { source: 'bold', title: 'Backend Engineer', company: null },
  );
  assert.deepEqual(
    extractLinkHint('Hiring QA automation lead!\nCall 054-1234567 or dana@acme.io\nhttps://www.linkedin.com/jobs/view/4458840528', 'https://www.linkedin.com/jobs/view/4458840528'),
    { source: 'text', text: 'Hiring QA automation lead! Call or' },
    'phone numbers and e-mail addresses are never kept',
  );
  // A digest with several links: only a slug can be tied to its link.
  assert.equal(extractLinkHint('*Many roles*\nhttps://www.linkedin.com/jobs/view/1111111111', 'https://www.linkedin.com/jobs/view/1111111111', { urlCount: 3 }), null);
  assert.equal(extractLinkHint('https://www.linkedin.com/jobs/view/1111111111', 'https://www.linkedin.com/jobs/view/1111111111'), null, 'no text, no hint');
});

test('a hint is kept until the job is decided, and a stronger hint replaces a weaker one only', (context) => {
  const store = tempStore(context);
  const { jobKey } = store.recordSighting({ url: 'https://www.linkedin.com/jobs/view/4458840528', source: 'WhatsApp: G' });
  assert.equal(store.setLinkHint(jobKey, { source: 'text', text: 'hiring' }), true);
  assert.equal(store.setLinkHint(jobKey, { source: 'slug', title: 'backend engineer', company: 'acme' }), true);
  assert.equal(store.setLinkHint(jobKey, { source: 'bold', title: 'x' }), false, 'weaker than the slug');
  assert.equal(JSON.parse(store.getJob(jobKey).link_hint).source, 'slug');
  store.archiveJob(jobKey);
  assert.equal(store.getJob(jobKey).link_hint, null, 'archiving clears it');
});

test('shared LinkedIn links are screened by their hint before any LinkedIn request', async (context) => {
  const store = tempStore(context);
  store.decideJob((() => {
    const { jobKey } = store.recordSighting({ url: 'https://boards.greenhouse.io/blockedco/jobs/1', company: 'BlockedCo', title: 'Backend Engineer', source: 'ATS: g' });
    store.saveEvaluation(jobKey, { company: 'BlockedCo', title: 'Backend Engineer', summary: 's', score: 4, fitLabel: 'מתאים', decisionReason: 'r',
      suitable: true, applyUrl: 'x', activeStatus: 'active', contentHash: 'c', profileHash: 'p1', criteriaVersion: 'v1', evaluatedAt: 1 });
    return jobKey;
  })(), 'company_not_interesting');

  const shared = (id, hint) => {
    const url = `https://www.linkedin.com/jobs/view/${id}`;
    const sighting = store.recordSighting({ url, source: 'WhatsApp: G' });
    if (hint) store.setLinkHint(sighting.jobKey, hint);
    return { ...sighting, url, source: 'WhatsApp: G' };
  };
  const negative = shared(4400000001, { source: 'bold', title: 'Senior Data Analyst' });
  const offTarget = shared(4400000002, { source: 'slug', title: 'office manager', company: 'acme' });
  const blocked = shared(4400000003, { source: 'slug', title: 'backend engineer', company: 'BlockedCo' });
  const looseText = shared(4400000004, { source: 'text', text: 'Great team, ping me' });
  const backend = shared(4400000005, { source: 'slug', title: 'senior backend engineer', company: 'acme' });
  const noHint = shared(4400000006, null);
  const fetched = [];

  const outcomes = await evaluateCandidates({
    candidates: [negative, offTarget, blocked, looseText, backend, noHint],
    store,
    config: { rootDir: process.cwd(), decision: { criteriaVersion: 'v1' }, sources: { whatsapp: {} } },
    fetcher: {
      fetch: async (url) => {
        fetched.push(url);
        return { status: 'active', finalUrl: url, contentHash: url, content: 'Senior Backend Engineer\nCompany: Acme\nBuild services.', identity: { company: 'Acme', title: 'Senior Backend Engineer' } };
      },
    },
    scorer: { profileHash: 'p1', scoreBatchSettled: async (items, { onProgress }) => onProgress({ completed: items.length, total: items.length, failed: 0, results: [], failures: [] }) },
  });

  for (const job of [negative, offTarget, blocked]) {
    assert.equal(outcomes.get(job.jobKey).status, 'filtered', job.url);
    assert.equal(fetched.includes(job.url), false, `${job.url} is never requested`);
  }
  // Rejected jobs keep only their identity (CLAUDE.md rule 3), so no reason is stored to check.
  // Free text is checked for negative keywords only; real titles and no hint are read.
  assert.deepEqual(fetched.sort(), [looseText.url, backend.url, noHint.url].sort());
});
