import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJobStore } from '../scripts/jobs/store.mjs';
import { createDashboardServer } from '../scripts/web.mjs';

async function startCompanyApi(context, overrides = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-company-api-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const config = {
    rootDir,
    jobsDbPath: path.join(rootDir, 'data', 'jobs.db'),
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: [] } },
  };
  const server = createDashboardServer({ config, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  return { config, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postJson(url, body = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('company API resolves a suitable job as candidate and watches only after approval', async (context) => {
  const { config, baseUrl } = await startCompanyApi(context);
  const store = createJobStore(config.jobsDbPath);
  const sighting = store.recordSighting({
    url: 'https://short.example/jobs/42', company: 'Example', title: 'Backend Engineer', source: 'WhatsApp: Jobs',
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Backend.', score: 4.5,
    fitLabel: 'בול מתאים', decisionReason: 'Relevant.', suitable: true,
    applyUrl: 'https://jobs.lever.co/example/role-id', activeStatus: 'active',
    contentHash: 'content', profileHash: 'profile', criteriaVersion: 'v1', evaluatedAt: Date.now(),
  });
  store.close();

  const resolvedResponse = await postJson(`${baseUrl}/api/companies/resolve`, { jobKey: sighting.jobKey });
  assert.equal(resolvedResponse.status, 200);
  const resolved = await resolvedResponse.json();
  assert.equal(resolved.candidate.status, 'candidate');
  assert.equal(resolved.sources[0].provider, 'lever');
  assert.equal(resolved.resolvedSource.careersUrl, 'https://jobs.lever.co/example');

  let list = await fetch(`${baseUrl}/api/companies`).then((response) => response.json());
  assert.equal(list.stats.candidate, 1);
  assert.equal(list.stats.watched, 0);

  const watchedResponse = await postJson(`${baseUrl}/api/companies/${resolved.candidate.id}/watch`);
  assert.equal(watchedResponse.status, 200);
  assert.equal((await watchedResponse.json()).company.status, 'watched');
  assert.equal((await postJson(`${baseUrl}/api/companies/${resolved.candidate.id}/watch`)).status, 200);

  const paused = await postJson(`${baseUrl}/api/companies/${resolved.candidate.id}/status`, { status: 'paused' });
  assert.equal(paused.status, 200);
  list = await fetch(`${baseUrl}/api/companies`).then((response) => response.json());
  assert.equal(list.stats.paused, 1);
});

test('company API researches a name but still requires explicit watch approval', async (context) => {
  const researchCompany = async (name) => ({
    candidate: {
      name, canonicalDomain: null, discoverySource: 'research', resolutionStatus: 'resolved', status: 'candidate',
      source: {
        provider: 'lever', boardKey: 'acme', careersUrl: 'https://jobs.lever.co/acme', apiUrl: null, enabled: true,
      },
    },
    research: {
      sourceKind: 'dedicated_ats', rationale: 'Verified official careers link.',
      evidenceUrls: ['https://www.acme.example/careers'],
    },
    probe: {
      status: 'verified_jobs', count: 2, errorCode: null,
      reason: 'נמצאו 2 משרות במקור שנבדק.',
      samples: [{ title: 'Backend Engineer', url: 'https://jobs.lever.co/acme/one' }],
    },
  });
  const { baseUrl } = await startCompanyApi(context, { researchCompany });
  const response = await postJson(`${baseUrl}/api/companies/research`, { name: 'Acme' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.candidate.status, 'candidate');
  assert.equal(result.sources[0].provider, 'lever');
  assert.equal(result.resolvedSource.careersUrl, 'https://jobs.lever.co/acme');
  assert.equal(result.research.sourceKind, 'dedicated_ats');
  assert.equal(result.probe.status, 'verified_jobs');
  assert.equal(result.sources[0].verificationStatus, 'verified_jobs');
  assert.equal(result.sources[0].lastJobCount, 2);
  assert.equal(result.sources[0].lastErrorReason, 'נמצאו 2 משרות במקור שנבדק.');

  const invalid = await postJson(`${baseUrl}/api/companies/research`, { name: 'Acme', url: 'https://example.com' });
  assert.equal(invalid.status, 400);
});

test('company API rejects unsafe URLs, unsupported watch requests and unknown fields', async (context) => {
  const { baseUrl } = await startCompanyApi(context);

  const unsafe = await postJson(`${baseUrl}/api/companies/resolve`, {
    name: 'Local Service', url: 'https://127.0.0.1/careers',
  });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).code, 'unsafe_url');

  const unknown = await postJson(`${baseUrl}/api/companies/resolve`, {
    name: 'Example', url: 'https://example.com/careers', provider: 'lever',
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, 'invalid_request');

  const candidate = await postJson(`${baseUrl}/api/companies/resolve`, {
    name: 'Example', url: 'https://example.com/careers',
  }).then((response) => response.json());
  const watch = await postJson(`${baseUrl}/api/companies/${candidate.candidate.id}/watch`);
  assert.equal(watch.status, 409);
  assert.equal((await watch.json()).code, 'company_not_scannable');
});
