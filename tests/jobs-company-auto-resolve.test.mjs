import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  boardUrlsFromRequests,
  careersPagesOf,
  comeetBoardFromApi,
  companyNameTokens,
  inferJobLinkPattern,
  openPositionsLinks,
  resolveCandidate,
  sourceBelongsToCompany,
  unsupportedPlatformIn,
} from '../scripts/jobs/company-auto-resolve.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const comeet = (slug, uid) => ({ provider: 'comeet', boardKey: `${slug}-${uid}`, careersUrl: `https://www.comeet.com/jobs/${slug}/${uid}` });

test('name tokens drop generic words but keep the joined name', () => {
  assert.deepEqual(companyNameTokens('Check Point Software Technologies').sort(), ['check', 'checkpoint', 'point']);
  assert.deepEqual(companyNameTokens('Itron, Inc.'), ['itron']);
});

test('a board belongs only when it carries the company name; site links may rely on the site host', () => {
  assert.equal(sourceBelongsToCompany({ source: comeet('papayagaming', '46.00B'), companyName: 'Papaya' }), true);
  // An investor's board embedded in a portfolio company's site (Lumia -> Team8).
  assert.equal(sourceBelongsToCompany({ source: comeet('team8', '61.003'), companyName: 'Lumia Security', discoveredOn: 'https://www.lumia.security/careers' }), false);
  // Wrong boards the import once picked (Greylock -> Lyra Health, Nebius -> TripleTen).
  assert.equal(sourceBelongsToCompany({ source: { provider: 'lever', boardKey: 'lyrahealth', careersUrl: 'https://jobs.lever.co/lyrahealth' }, companyName: 'Greylock Partners' }), false);
  assert.equal(sourceBelongsToCompany({ source: comeet('tripleten', '98.008'), companyName: 'Nebius' }), false);
  // Job links read off the company's own site.
  const own = { provider: 'official-html', careersUrl: 'https://www.withfaye.com/careers' };
  assert.equal(sourceBelongsToCompany({ source: own, companyName: 'Faye', discoveredOn: 'https://www.withfaye.com/careers' }), true);
  const portfolio = { provider: 'official-html', careersUrl: 'https://team8.vc/careers' };
  assert.equal(sourceBelongsToCompany({ source: portfolio, companyName: 'Encore AI', discoveredOn: 'https://team8.vc/careers' }), false);
});

test('a repeated job-link shape is inferred, including links under their own id folders', () => {
  const page = 'https://www.guesty.com/careers-open-positions';
  const links = [
    { href: 'https://www.guesty.com/careers-open-positions/co/tel-aviv/73.B5C/backend-engineer', text: 'Backend Engineer' },
    { href: 'https://www.guesty.com/careers-open-positions/co/tel-aviv/73.B5D/product-manager', text: 'Product Manager' },
    { href: 'https://www.guesty.com/careers-open-positions/co/manila/73.B5E/office-administrator', text: 'Office Administrator' },
    ...['a', 'b', 'c', 'd'].map((slug) => ({ href: `https://www.guesty.com/features/${slug}`, text: `Feature ${slug}` })),
    { href: 'https://elsewhere.example/careers/x/y', text: 'Engineer' },
  ];
  assert.deepEqual(inferJobLinkPattern(links, page), { jobPathPrefix: '/careers-open-positions/co/', jobPathSegments: 5, count: 3 });
  assert.equal(inferJobLinkPattern(links.slice(3), page), null);
  // Investor-relations or leadership pages are never a job list, whatever their link texts.
  const investors = ['ceo', 'cfo', 'coo', 'cto'].map((slug) => ({ href: `https://team.example/investor-relations/${slug}`, text: 'Director, Management' }));
  assert.equal(inferJobLinkPattern(investors, 'https://team.example/'), null);
});

test('a generic company name never matches a host by itself', () => {
  assert.deepEqual(companyNameTokens('Team'), []);
  assert.equal(sourceBelongsToCompany({ source: { provider: 'official-html', careersUrl: 'https://team.example/careers' }, companyName: 'Team', discoveredOn: 'https://team.example/careers' }), false);
});

test('background ATS calls become boards, and a Comeet API call yields its public board', async () => {
  const { boards, comeetApis } = boardUrlsFromRequests([
    'https://www.comeet.co/careers-api/2.0/company/C5.00D/positions?token=ABCDEF1234567890ABCD&details=false',
    'https://api.lever.co/v0/postings/acme?mode=json',
    'https://www.google-analytics.com/collect?v=1',
  ]);
  assert.deepEqual(comeetApis, ['https://www.comeet.co/careers-api/2.0/company/C5.00D/positions?token=ABCDEF1234567890ABCD']);
  assert.ok(boards.includes('https://jobs.lever.co/acme'));
  const board = await comeetBoardFromApi(comeetApis[0], async () => [
    { name: 'Backend Engineer', url_comeet_hosted_page: 'https://www.comeet.com/jobs/pentera/C5.00D/backend-engineer/C5.123' },
  ]);
  assert.equal(board, 'https://www.comeet.com/jobs/pentera/C5.00D');
});

test('known unsupported platforms and "open positions" links are recognised', () => {
  assert.equal(unsupportedPlatformIn(['https://jobs.akamai.com/en/sites/CX_1/jobs']), 'Oracle Recruiting');
  assert.equal(unsupportedPlatformIn(['https://example.com/careers']), null);
  assert.deepEqual(openPositionsLinks([
    { href: 'https://aiven.io/careers', text: 'Careers' },
    { href: 'https://aiven.io/careers/job', text: 'See our open positions' },
  ], 'https://aiven.io/careers'), ['https://aiven.io/careers/job']);
});

test('careers pages exclude job boards and known ATS boards', () => {
  const company = { sources: [
    { provider: 'unsupported', careersUrl: 'https://www.linkedin.com/jobs/view/1', discoveryEvidence: [] },
    { provider: 'unsupported', careersUrl: 'https://acme.example/careers', discoveryEvidence: ['https://acme.example/careers', 'https://jobs.lever.co/acme'] },
  ] };
  assert.deepEqual(careersPagesOf(company), ['https://acme.example/careers']);
});

const page = (url, links = [], requests = []) => ({ url, html: '<html></html>', links, requests });
const verified = async (source) => ({ status: 'verified_jobs', count: 5, samples: [], errorCode: null, reason: 'ok', source });

test('a candidate is watched through the job links on its own careers site', async () => {
  const company = { name: 'Faye', sources: [{ provider: 'unsupported', careersUrl: 'https://www.withfaye.com/careers', discoveryEvidence: ['https://www.withfaye.com/careers'] }] };
  const outcome = await resolveCandidate(company, {
    discoverPage: async (url) => page(url, ['backend-engineer', 'product-manager', 'qa-engineer'].map((slug) => ({ href: `https://www.withfaye.com/careers/${slug}`, text: slug }))),
    probe: verified,
  });
  assert.equal(outcome.status, 'watched');
  assert.equal(outcome.source.provider, 'official-html');
  assert.equal(outcome.source.config.jobPathPrefix, '/careers/');
});

test('a candidate that only has someone else\'s board, or only job boards, gets a reason', async () => {
  const lumia = { name: 'Lumia Security', sources: [{ provider: 'unsupported', careersUrl: 'https://www.lumia.security/careers', discoveryEvidence: ['https://www.lumia.security/careers'] }] };
  const mismatch = await resolveCandidate(lumia, {
    discoverPage: async (url) => page(url, [{ href: 'https://www.comeet.com/jobs/team8/61.003', text: 'Jobs' }]),
    probe: verified,
  });
  assert.equal(mismatch.status, 'unscannable');
  assert.equal(mismatch.reason, 'board_name_mismatch');
  assert.equal(mismatch.detail, 'https://www.comeet.com/jobs/team8/61.003');
  // Kept for a one-click approval, never watched automatically.
  assert.equal(mismatch.source.provider, 'comeet');

  const varix = { name: 'VARIX IO', sources: [{ provider: 'unsupported', careersUrl: 'https://www.linkedin.com/jobs/view/42', discoveryEvidence: [] }] };
  const boardsOnly = await resolveCandidate(varix, { discoverPage: async () => { throw new Error('not called'); }, probe: verified });
  assert.equal(boardsOnly.reason, 'job_boards_only');

  const akamai = { name: 'Akamai Technologies', sources: [{ provider: 'unsupported', careersUrl: 'https://jobs.akamai.com/en/sites/CX_1/jobs', discoveryEvidence: ['https://jobs.akamai.com/en/sites/CX_1/jobs'] }] };
  const platform = await resolveCandidate(akamai, { discoverPage: async (url) => page(url), probe: verified });
  assert.deepEqual(platform, { status: 'unscannable', reason: 'unsupported_platform', detail: 'Oracle Recruiting' });
});

test('the store lists due candidates and records outcomes with a retry time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-auto-resolve-'));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  const { company } = store.upsertCompanyCandidate({ name: 'Acme', jobUrl: 'https://acme.example/careers', discoverySource: 'manual' });
  assert.deepEqual(store.listCompaniesDueForAutoResolve({ now: 1_000 }).map((item) => item.name), ['Acme']);

  store.recordAutoResolve(company.id, { status: 'unscannable', reason: 'no_jobs_found', detail: 'https://acme.example/careers', at: 1_000, nextAt: 5_000 });
  assert.deepEqual(store.listCompaniesDueForAutoResolve({ now: 2_000 }), []);
  assert.equal(store.listCompaniesDueForAutoResolve({ now: 6_000 }).length, 1);
  assert.deepEqual(store.getCompany(company.id).autoResolve, {
    status: 'unscannable', reason: 'no_jobs_found', detail: 'https://acme.example/careers', checkedAt: 1_000, nextAt: 5_000,
  });
  store.close();
});
