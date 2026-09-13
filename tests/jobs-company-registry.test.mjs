import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  CompanyRegistryError,
  detectCompanyJobSource,
  normalizeCompanySource,
  resolveCompanyCandidate,
} from '../scripts/jobs/company-registry.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-companies-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

test('resolves supported ATS job URLs without network access or implicit approval', () => {
  const result = resolveCompanyCandidate({
    company: '  Example  Labs ',
    jobUrl: 'https://job-boards.greenhouse.io/examplelabs/jobs/123?gh_src=wa',
    discoverySource: 'whatsapp',
  });

  assert.deepEqual(result, {
    name: 'Example Labs',
    canonicalDomain: null,
    discoverySource: 'whatsapp',
    resolutionStatus: 'resolved',
    status: 'candidate',
    source: {
      provider: 'greenhouse',
      boardKey: 'examplelabs',
      careersUrl: 'https://job-boards.greenhouse.io/examplelabs',
      apiUrl: 'https://boards-api.greenhouse.io/v1/boards/examplelabs/jobs',
      enabled: true,
    },
  });
});

test('detects every ATS shape supported by the scanner', () => {
  const cases = [
    ['https://jobs.lever.co/acme/role-id', 'lever', 'acme', 'https://jobs.lever.co/acme'],
    ['https://jobs.ashbyhq.com/acme/role-id', 'ashby', 'acme', 'https://jobs.ashbyhq.com/acme'],
    ['https://apply.workable.com/acme/j/ABC/', 'workable', 'acme', 'https://apply.workable.com/acme'],
    ['https://acme.recruitee.com/o/backend-engineer', 'recruitee', 'acme', 'https://acme.recruitee.com'],
    ['https://jobs.smartrecruiters.com/Acme/123-backend', 'smartrecruiters', 'acme', 'https://jobs.smartrecruiters.com/Acme'],
    ['https://www.comeet.com/jobs/acme/A9.002', 'comeet', 'acme-a9.002', 'https://www.comeet.com/jobs/acme/A9.002'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/One', 'workday', 'acme-careers', 'https://acme.wd1.myworkdayjobs.com/en-US/Careers'],
    ['https://acme.zohorecruit.com/jobs/Careers/123/Role', 'zoho-recruit', 'acme-careers', 'https://acme.zohorecruit.com/jobs/Careers'],
    ['https://acme.teamme.link/', 'teamme', 'acme', 'https://acme.teamme.link'],
  ];

  for (const [url, provider, boardKey, careersUrl] of cases) {
    assert.deepEqual(detectCompanyJobSource(url), {
      provider,
      boardKey,
      careersUrl,
      apiUrl: null,
      enabled: true,
    });
  }
});

test('unsupported official job URLs remain reviewable and are never scanner-enabled', () => {
  const candidate = resolveCompanyCandidate({
    company: 'Acme',
    jobUrl: 'https://www.acme.example/careers/backend?utm_source=wa',
  });

  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.resolutionStatus, 'unsupported');
  assert.equal(candidate.canonicalDomain, 'acme.example');
  assert.deepEqual(candidate.source, {
    provider: 'unsupported',
    boardKey: null,
    careersUrl: 'https://www.acme.example/careers/backend',
    apiUrl: null,
    enabled: false,
  });
});

test('rejects malformed, unsafe, and oversized resolver input', () => {
  const invalid = [
    { company: '', jobUrl: 'https://jobs.lever.co/acme/one' },
    { company: 'x'.repeat(121), jobUrl: 'https://jobs.lever.co/acme/one' },
    { company: 'Acme', jobUrl: 'javascript:alert(1)' },
    { company: 'Acme', jobUrl: 'http://127.0.0.1/jobs/one' },
    { company: 'Acme', jobUrl: 'https://[::1]/jobs/one' },
    { company: 'Acme', jobUrl: `https://example.com/${'x'.repeat(2050)}` },
  ];

  for (const input of invalid) {
    assert.throws(() => resolveCompanyCandidate(input), CompanyRegistryError);
  }
});

test('rejects an explicit provider that contradicts the ATS URL', () => {
  assert.throws(
    () => normalizeCompanySource({
      provider: 'lever',
      careersUrl: 'https://job-boards.greenhouse.io/acme',
    }),
    (error) => error instanceof CompanyRegistryError && error.code === 'provider_mismatch',
  );
  assert.throws(
    () => normalizeCompanySource({
      provider: 'lever', boardKey: 'acme', careersUrl: 'https://careers.acme.example/jobs',
    }),
    (error) => error instanceof CompanyRegistryError && error.code === 'provider_mismatch',
  );
});

test('explicit official HTML sources are scannable without pretending to be an ATS', () => {
  assert.deepEqual(normalizeCompanySource({
    provider: 'official-html',
    careersUrl: 'https://www.appcharge.com/careers',
    enabled: true,
  }), {
    provider: 'official-html', boardKey: null,
    careersUrl: 'https://www.appcharge.com/careers', apiUrl: null, enabled: true,
  });
});

test('candidate persistence is idempotent and duplicate domains/sources converge', () => {
  const store = newStore();
  const first = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'Acme',
    jobUrl: 'https://acme.example/careers/backend',
    discoverySource: 'whatsapp',
  }), 100);
  const second = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'ACME',
    jobUrl: 'https://acme.example/jobs/data',
    discoverySource: 'manual',
  }), 200);

  assert.equal(first.company.id, second.company.id);
  assert.equal(store.listCompanies().length, 1);
  assert.equal(store.getCompany(first.company.id).status, 'candidate');
  assert.equal(store.listWatchedCompanySources().length, 0);
  store.close();
});

test('configured companies on a shared unsupported job host remain separate', () => {
  const store = newStore();
  const entries = [
    { name: 'Alpha', careers_url: 'https://www.comeet.com/jobs/alpha/AA.001', enabled: false },
    { name: 'Beta', careers_url: 'https://www.comeet.com/jobs/beta/BB.002', enabled: false },
  ];

  assert.deepEqual(store.importConfiguredCompanies(entries, 100), { imported: 2, skipped: 0 });
  assert.deepEqual(store.listCompanies().map((company) => company.name).sort(), ['Alpha', 'Beta']);
  assert.equal(store.listCompanies().every((company) => company.canonicalDomain === null), true);
  store.close();
});

test('configured import repairs legacy shared-host source ownership', () => {
  const store = newStore();
  const alphaSource = {
    provider: 'unsupported', boardKey: null,
    careersUrl: 'https://www.comeet.com/jobs/alpha/AA.001', apiUrl: null, enabled: false,
  };
  const betaSource = {
    provider: 'unsupported', boardKey: null,
    careersUrl: 'https://www.comeet.com/jobs/beta/BB.002', apiUrl: null, enabled: false,
  };
  const legacy = store.upsertCompanyCandidate({
    name: 'Alpha', canonicalDomain: 'comeet.com', discoverySource: 'configured',
    resolutionStatus: 'unsupported', source: alphaSource,
  }, 100);
  store.upsertCompanySource(legacy.company.id, betaSource, 100);

  const entries = [
    { name: 'Alpha', careers_url: alphaSource.careersUrl, enabled: false },
    { name: 'Beta', careers_url: betaSource.careersUrl, enabled: false },
  ];
  assert.deepEqual(store.importConfiguredCompanies(entries, 200), { imported: 2, skipped: 0 });

  const companies = store.listCompanies().sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(companies.map((company) => company.name), ['Alpha', 'Beta']);
  assert.equal(companies.every((company) => company.canonicalDomain === null), true);
  assert.deepEqual(companies.map((company) => company.sources.length), [1, 1]);
  store.close();
});

test('store migration adds Comeet and official HTML to an existing company source table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-companies-migration-'));
  const databasePath = path.join(dir, 'jobs.db');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE, canonical_domain TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'candidate', discovery_source TEXT NOT NULL,
      resolution_status TEXT NOT NULL DEFAULT 'unsupported', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE company_job_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL CHECK(provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'unsupported')),
      board_key TEXT, careers_url TEXT NOT NULL, api_url TEXT, enabled INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'unknown', last_checked_at INTEGER, last_success_at INTEGER,
      last_error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX company_job_sources_company_idx ON company_job_sources(company_id, enabled);
  `);
  legacy.close();

  const store = createJobStore(databasePath);
  const saved = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'Finubit', jobUrl: 'https://www.comeet.com/jobs/finubit/A9.002',
  }));
  assert.equal(saved.sources[0].provider, 'comeet');
  const htmlSource = store.upsertCompanyCandidate({
    name: 'Appcharge', canonicalDomain: 'appcharge.com', discoverySource: 'configured',
    resolutionStatus: 'resolved', status: 'candidate',
    source: {
      provider: 'official-html', boardKey: null,
      careersUrl: 'https://www.appcharge.com/careers', apiUrl: null, enabled: true,
    },
  });
  assert.equal(htmlSource.sources[0].provider, 'official-html');
  store.close();
});

test('configured official HTML upgrade activates an auto-paused unsupported company', () => {
  const store = newStore();
  store.importConfiguredCompanies([{
    name: 'Appcharge', careers_url: 'https://www.appcharge.com/careers', enabled: false,
  }], 100);
  assert.equal(store.listCompanies()[0].status, 'paused');

  store.importConfiguredCompanies([{
    name: 'Appcharge', careers_url: 'https://www.appcharge.com/careers',
    provider: 'official-html', enabled: true,
  }], 200);

  const company = store.listCompanies()[0];
  assert.equal(company.status, 'watched');
  assert.equal(company.resolutionStatus, 'resolved');
  assert.deepEqual(company.sources.map((source) => source.provider), ['official-html']);
  store.close();
});

test('only explicit approval creates watched scanner entries', () => {
  const store = newStore();
  const saved = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'Example Labs',
    jobUrl: 'https://jobs.lever.co/example/role-id',
    discoverySource: 'whatsapp',
  }), 100);

  assert.equal(saved.company.status, 'candidate');
  assert.throws(
    () => store.setCompanyStatus(saved.company.id, 'watched', 200),
    /approveCompany/,
  );
  assert.equal(store.approveCompany(saved.company.id, 300), true);
  assert.deepEqual(store.listWatchedCompanySources(), [{
    name: 'Example Labs',
    careers_url: 'https://jobs.lever.co/example',
    provider: 'lever',
    enabled: true,
    sourceId: saved.sources[0].id,
  }]);
  assert.equal(store.approveCompany(saved.company.id, 400), true);
  store.close();
});

test('provider configuration survives the registry and reaches the daily scanner', () => {
  const store = newStore();
  store.importConfiguredCompanies([{
    name: 'Dynamic Yield', provider: 'workday', enabled: true,
    careers_url: 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers',
    search_text: 'Dynamic Yield',
  }], 100);
  assert.deepEqual(store.listWatchedCompanySources(), [{
    name: 'Dynamic Yield', provider: 'workday', enabled: true,
    careers_url: 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers',
    search_text: 'Dynamic Yield', sourceId: 1,
  }]);
  store.close();
});

test('source probes persist bounded verification evidence and reject malformed results', () => {
  const store = newStore();
  const saved = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'Acme', jobUrl: 'https://jobs.ashbyhq.com/acme', discoverySource: 'research',
  }), 100);
  const sourceId = saved.sources[0].id;

  assert.equal(store.recordCompanySourceProbe(sourceId, {
    status: 'verified_jobs', count: 3, errorCode: null,
    reason: 'נמצאו 3 משרות במקור שנבדק.',
  }, ['https://www.acme.example/careers'], 200), true);

  const source = store.getCompany(saved.company.id).sources[0];
  assert.equal(source.verificationStatus, 'verified_jobs');
  assert.equal(source.lastJobCount, 3);
  assert.equal(source.health, 'healthy');
  assert.equal(source.lastProbeAt, 200);
  assert.deepEqual(source.discoveryEvidence, ['https://www.acme.example/careers']);
  assert.throws(
    () => store.recordCompanySourceProbe(sourceId, { status: 'invented', count: 0 }),
    (error) => error.code === 'invalid_probe_status',
  );
  assert.throws(
    () => store.recordCompanySourceProbe(sourceId, { status: 'verified_jobs', count: 5_001 }),
    (error) => error.code === 'invalid_probe_count',
  );
  store.close();
});

test('duplicate ATS source cannot be attached to two companies', () => {
  const store = newStore();
  const first = store.upsertCompanyCandidate(resolveCompanyCandidate({
    company: 'First Name',
    jobUrl: 'https://jobs.ashbyhq.com/shared/one',
  }));
  const second = store.upsertCompanyCandidate({
    ...resolveCompanyCandidate({ company: 'Second Name', jobUrl: 'https://jobs.ashbyhq.com/shared/two' }),
    source: null,
  });

  assert.throws(
    () => store.upsertCompanySource(second.company.id, first.sources[0]),
    (error) => error instanceof CompanyRegistryError && error.code === 'source_conflict',
  );
  store.close();
});

test('stored suitable jobs resolve to candidates without mutating the registry', () => {
  const store = newStore();
  const sighting = store.recordSighting({
    url: 'https://jobs.lever.co/example/role-id',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'WhatsApp: Jobs',
    seenAt: 100,
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Backend systems.', score: 4.5,
    fitLabel: 'בול מתאים', decisionReason: 'Relevant.', suitable: true,
    applyUrl: 'https://jobs.lever.co/example/role-id', activeStatus: 'active',
    contentHash: 'content', profileHash: 'profile', criteriaVersion: 'v1', evaluatedAt: 200,
  });

  const candidate = store.resolveCompanyCandidateForJob(sighting.jobKey);
  assert.equal(candidate.source.provider, 'lever');
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(store.listCompanies(), []);

  const rejected = store.recordSighting({ url: 'https://jobs.lever.co/nope/role', source: 'WhatsApp: Jobs' });
  assert.throws(
    () => store.resolveCompanyCandidateForJob(rejected.jobKey),
    (error) => error instanceof CompanyRegistryError && error.code === 'job_not_suitable',
  );
  store.close();
});

test('stored jobs resolve from the evaluated final URL rather than a WhatsApp shortener', () => {
  const store = newStore();
  const sighting = store.recordSighting({
    url: 'https://api.dueto.io/Redirect/short-id',
    company: 'Example',
    title: 'Backend Engineer',
    source: 'WhatsApp: Jobs',
  });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Example', title: 'Backend Engineer', summary: 'Backend systems.', score: 4.5,
    fitLabel: 'בול מתאים', decisionReason: 'Relevant.', suitable: true,
    applyUrl: 'https://jobs.ashbyhq.com/example/final-role', activeStatus: 'active',
    contentHash: 'content', profileHash: 'profile', criteriaVersion: 'v1', evaluatedAt: 200,
  });

  const candidate = store.resolveCompanyCandidateForJob(sighting.jobKey);
  assert.equal(candidate.source.provider, 'ashby');
  assert.equal(candidate.source.boardKey, 'example');
  assert.equal(candidate.discoverySource, 'whatsapp');
  store.close();
});

test('configured company import is additive, idempotent, and preserves user state', () => {
  const store = newStore();
  const entries = [
    { name: 'Enabled Co', careers_url: 'https://jobs.lever.co/enabled', enabled: true },
    { name: 'Paused Co', careers_url: 'https://jobs.ashbyhq.com/paused', enabled: false },
  ];

  assert.deepEqual(store.importConfiguredCompanies(entries, 100), { imported: 2, skipped: 0 });
  const enabled = store.listCompanies().find((company) => company.name === 'Enabled Co');
  const paused = store.listCompanies().find((company) => company.name === 'Paused Co');
  assert.equal(enabled.status, 'watched');
  assert.equal(paused.status, 'paused');

  store.setCompanyStatus(enabled.id, 'ignored', 200);
  assert.deepEqual(store.importConfiguredCompanies(entries, 300), { imported: 2, skipped: 0 });
  assert.equal(store.listCompanies().length, 2);
  assert.equal(store.getCompany(enabled.id).status, 'ignored');
  store.close();
});
