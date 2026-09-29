import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJobStore } from '../scripts/jobs/store.mjs';
import {
  buildTitleIncludeFilter, postedAgeLowerBoundMs,
  buildLinkedInAreaFilter, buildSearchUrl, classifySearchResponse, createLinkedInBudget, isFallbackPage,
  parsePostingPage, parseSearchPage, runLinkedInSearch, scanLinkedIn, searchTerms,
} from '../scripts/jobs/sources/linkedin.mjs';

// Synthetic markup mirroring the guest search response shape (verified
// against the live endpoint on 2026-09-28; no real LinkedIn content stored).
function card({ id, title = 'Backend Engineer', company = 'Acme', location = 'Tel Aviv-Yafo, Tel Aviv District, Israel', date = '2026-09-28', ago = '3 hours ago' }) {
  return `<li><div class="base-card base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://il.linkedin.com/jobs/view/x-at-y-${id}?position=1&amp;refId=r&amp;trackingId=t"><span class="sr-only">${title}</span></a>
    <div class="base-search-card__info"><h3 class="base-search-card__title">
      ${title}
    </h3><h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="#">${company}</a></h4>
    <div class="base-search-card__metadata"><span class="job-search-card__location">${location}</span>
    <time class="job-search-card__listdate--new" datetime="${date}">
      ${ago}
    </time></div></div></div></li>`;
}

function page(cards) {
  return `<!DOCTYPE html>\n${cards.map(card).join('\n')}`;
}

// A plain object rather than Response: LinkedIn's non-standard HTTP 999
// is outside the range the Response constructor accepts.
function response(body, status = 200, url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search') {
  return { status, url, text: async () => body };
}

const noSleep = async () => {};
const search = { id: 1, label: 'Backend', keywords: 'backend OR "back end" OR "server side"', location: 'Israel' };
const window = { from: Date.UTC(2026, 8, 28, 0), to: Date.UTC(2026, 8, 28, 12) };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-linkedin-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

test('search URL carries the time window, sort and pagination, and never Easy Apply or seniority filters', () => {
  const url = new URL(buildSearchUrl({ keywords: 'data analyst', location: 'Israel', tprSeconds: 43_200.4, start: 20 }));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(url.searchParams.get('f_TPR'), 'r43201');
  assert.equal(url.searchParams.get('start'), '20');
  assert.equal(url.searchParams.get('sortBy'), 'DD');
  assert.equal(url.searchParams.get('f_AL'), null);
  assert.equal(url.searchParams.get('f_E'), null);
});

test('search cards are parsed into stable ids with entities decoded', () => {
  const { cards } = parseSearchPage(page([
    { id: '4425439971', title: 'Senior Backend Engineer', company: 'R&amp;D Labs' },
    { id: '4425439971' },
    { id: '4472702432', location: 'Tel Aviv District, Israel', date: '2026-09-27' },
  ]));
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    linkedinId: '4425439971',
    title: 'Senior Backend Engineer',
    company: 'R&D Labs',
    location: 'Tel Aviv-Yafo, Tel Aviv District, Israel',
    listedAt: '2026-09-28',
    postedLabel: '3 hours ago',
    postedAgeMs: 3 * 3_600_000,
    url: 'https://www.linkedin.com/jobs/view/4425439971',
  });
});

test('responses are classified so that no failure can pass for "no jobs"', () => {
  assert.equal(classifySearchResponse({ status: 200, html: '', cards: [] }).status, 'empty');
  assert.equal(classifySearchResponse({ status: 400, html: '', cards: [] }).status, 'empty');
  assert.equal(classifySearchResponse({ status: 429, html: '', cards: [] }).status, 'rate_limited');
  assert.equal(classifySearchResponse({ status: 999, html: '', cards: [] }).status, 'blocked');
  assert.equal(classifySearchResponse({ status: 200, finalUrl: 'https://www.linkedin.com/authwall?trk=x', html: '<p>x</p>', cards: [] }).status, 'blocked');
  assert.equal(classifySearchResponse({ status: 200, html: '<main>Sign in to continue</main>', cards: [] }).status, 'blocked');
  assert.equal(classifySearchResponse({ status: 200, html: '<ul><li><div class="new-card">Job</div></li></ul>', cards: [] }).status, 'structure_changed');
  assert.equal(classifySearchResponse({ status: 503, html: '', cards: [] }).status, 'network_error');
  assert.equal(classifySearchResponse({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }).status, 'timeout');
  assert.equal(classifySearchResponse({ error: new Error('fetch failed') }).status, 'network_error');
});

test('LinkedIn substitute results for unmatched queries are recognized as fallback pages', () => {
  assert.deepEqual(searchTerms('backend OR "back end" OR "server side"'), ['backend', 'back', 'server']);
  const unrelated = ['Offshore Chemist', 'BIM Consultant', 'Revenue Enablement Manager', 'Ad Ops Manager']
    .map((title) => ({ title }));
  const related = ['Backend Engineer', '.NET Developer', 'Nodejs Developer', 'Senior Backend Engineer']
    .map((title) => ({ title }));
  assert.equal(isFallbackPage(unrelated, search.keywords), true);
  assert.equal(isFallbackPage(related, search.keywords), false);
});

test('pagination advances by the number of cards and stops on an empty page', async () => {
  const starts = [];
  const pages = [
    page(Array.from({ length: 10 }, (_, index) => ({ id: String(1_000_000 + index) }))),
    page(Array.from({ length: 7 }, (_, index) => ({ id: String(2_000_000 + index) }))),
    '',
  ];
  const fetchImpl = async (url) => {
    starts.push(Number(new URL(url).searchParams.get('start')));
    return response(pages.shift());
  };
  const result = await runLinkedInSearch({ search, window, budget: createLinkedInBudget(), fetchImpl, sleep: noSleep });
  assert.deepEqual(starts, [0, 10, 17]);
  assert.equal(result.status, 'complete');
  assert.equal(result.endedBy, 'end_of_results');
  assert.equal(result.cards.length, 17);
  assert.equal(result.tprSeconds, 12 * 3600);
});

test('a repeated page ends pagination instead of looping', async () => {
  const same = page([{ id: '1000001' }, { id: '1000002' }]);
  let calls = 0;
  const result = await runLinkedInSearch({ search, window, budget: createLinkedInBudget(), sleep: noSleep,
    fetchImpl: async () => { calls += 1; return response(same); } });
  assert.equal(calls, 2);
  assert.equal(result.endedBy, 'repeated_page');
  assert.equal(result.cards.length, 2);
});

test('hitting the page limit is partial and marked capped', async () => {
  let next = 1_000_000;
  const result = await runLinkedInSearch({
    search, window, sleep: noSleep,
    budget: createLinkedInBudget({ maxPagesPerSearch: 2 }),
    fetchImpl: async () => response(page(Array.from({ length: 10 }, () => ({ id: String(next++) })))),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.capped, true);
  assert.equal(result.endedBy, 'page_limit');
  assert.equal(result.cards.length, 20);
});

test('a block mid-search keeps collected cards as partial and halts the shared budget', async () => {
  const responses = [response(page([{ id: '1000001' }])), response('', 429)];
  const budget = createLinkedInBudget();
  const result = await runLinkedInSearch({ search, window, budget, sleep: noSleep, fetchImpl: async () => responses.shift() });
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'rate_limited');
  assert.equal(budget.haltedBy, 'rate_limited');
  const next = await runLinkedInSearch({ search, window, budget, sleep: noSleep, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(next.status, 'failed');
  assert.equal(next.reason, 'rate_limited');
});

test('a timeout on the first page fails the search instead of reporting zero jobs', async () => {
  const result = await runLinkedInSearch({ search, window, budget: createLinkedInBudget(), sleep: noSleep,
    fetchImpl: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.cards.length, 0);
});

test('posting pages expose description, criteria and an offsite apply URL when present', () => {
  const posting = parsePostingPage(`<h2 class="top-card-layout__title topcard__title">Data Analyst</h2>
    <a class="topcard__org-name-link" href="#">Acme</a>
    <code id="applyUrl" style="display: none"><!--"https://www.linkedin.com/jobs/view/externalApply/1?url=https%3A%2F%2Fboards%2Egreenhouse%2Eio%2Facme%2Fjobs%2F77&amp;urlHash=x"--></code>
    <div class="show-more-less-html__markup">SQL and dashboards.<br>Python.</div>
    <h3 class="description__job-criteria-subheader">Employment type</h3>
    <span class="description__job-criteria-text description__job-criteria-text--criteria">Full-time</span>`);
  assert.equal(posting.title, 'Data Analyst');
  assert.equal(posting.company, 'Acme');
  assert.match(posting.description, /SQL and dashboards/);
  assert.deepEqual(posting.criteria, { 'Employment type': 'Full-time' });
  assert.equal(posting.applyUrl, 'https://boards.greenhouse.io/acme/jobs/77');
  assert.equal(posting.closed, false);
});

test('area filter keeps Tel Aviv and Center districts and ambiguous bare Israel', () => {
  const passes = buildLinkedInAreaFilter();
  assert.equal(passes('Ramat Gan, Tel Aviv District, Israel'), true);
  assert.equal(passes('Raanana, Center District, Israel'), true);
  assert.equal(passes('Israel'), true);
  assert.equal(passes('Haifa, Haifa District, Israel'), false);
  assert.equal(passes('Jerusalem, Jerusalem District, Israel'), false);
});

function linkedinConfig(overrides = {}) {
  return {
    decision: { criteriaVersion: 'test' },
    sources: { linkedin: { enabled: true, limits: { delayMs: [0, 0] }, ...overrides } },
  };
}

test('collection records new postings as pending, filters locally, and advances coverage only when complete', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([{ key: 'backend', label: 'Backend', keywords: search.keywords, location: 'Israel' }]);
  const now = Date.UTC(2026, 8, 28, 12);
  const pages = [page([
    { id: '1000001', title: 'Backend Engineer' },
    { id: '1000002', title: 'Junior Backend Developer' },
    { id: '1000003', title: 'Server Side Engineer', location: 'Haifa, Haifa District, Israel' },
  ]), ''];
  const result = await scanLinkedIn({
    config: linkedinConfig(), store, now, sleep: noSleep,
    passesTitle: (title) => !/junior/i.test(title),
    fetchImpl: async () => response(pages.shift()),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'LinkedIn: Backend');
  assert.equal(result.candidates[0].url, 'https://www.linkedin.com/jobs/view/1000001');
  assert.deepEqual(
    (({ status, found, new: fresh, known, filtered, advanced }) => ({ status, found, fresh, known, filtered, advanced }))(result.searches[0]),
    { status: 'complete', found: 3, fresh: 3, known: 0, filtered: 2, advanced: true },
  );
  const pending = store.listPendingEvaluation();
  assert.deepEqual(pending.map((job) => job.url), ['https://www.linkedin.com/jobs/view/1000001']);
  const [saved] = store.listLinkedInSearches();
  assert.equal(saved.coveredUntil, now);
  assert.equal(saved.lastStatus, 'complete');

  // Re-running finds the same postings as known and queues nothing new.
  const again = await scanLinkedIn({
    config: linkedinConfig(), store, now: now + 3_600_000, sleep: noSleep,
    fetchImpl: (() => {
      const queue = [page([{ id: '1000001' }, { id: '1000002', title: 'Junior Backend Developer' }]), ''];
      return async () => response(queue.shift());
    })(),
  });
  assert.equal(again.candidates.length, 0);
  assert.equal(again.searches[0].known, 2);
  store.close();
});

test('a failed collection keeps the previous coverage and records the reason', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([{ key: 'backend', label: 'Backend', keywords: search.keywords, location: 'Israel' }]);
  const [before] = store.listLinkedInSearches();
  store.recordLinkedInSearchAttempt({ searchId: before.id, queryHash: before.queryHash, status: 'complete', coveredUntil: 1_000 });

  const result = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep, fetchImpl: async () => response('', 999) });

  assert.equal(result.searches[0].status, 'failed');
  assert.equal(result.errors[0].code, 'linkedin_blocked');
  const [after] = store.listLinkedInSearches();
  assert.equal(after.coveredUntil, 1_000);
  assert.equal(after.lastStatus, 'failed');
  assert.equal(after.lastReason, 'blocked');
  store.close();
});

test('an empty first page is not trusted unless LinkedIn answered another search in the same run', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([
    { key: 'a', label: 'A', keywords: 'data analyst', location: 'Israel' },
  ]);
  const lonely = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep, fetchImpl: async () => response('') });
  assert.equal(lonely.searches[0].status, 'failed');
  assert.equal(lonely.searches[0].reason, 'empty_unverified');
  assert.equal(store.listLinkedInSearches()[0].coveredUntil, null);

  store.syncLinkedInSearches([
    { key: 'a', label: 'A', keywords: 'data analyst', location: 'Israel' },
    { key: 'b', label: 'B', keywords: 'backend', location: 'Israel' },
  ]);
  const queue = ['', page([{ id: '1000009', title: 'Backend Engineer' }]), ''];
  const answered = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep, fetchImpl: async () => response(queue.shift()) });
  assert.deepEqual(answered.searches.map((row) => row.status), ['complete', 'complete']);
  store.close();
});

test('a fallback page of unrelated jobs is recorded as no matches and never queued for scoring', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([{ key: 'a', label: 'Analyst', keywords: '"data analyst"', location: 'Israel' }]);
  const result = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep,
    fetchImpl: async () => response(page([{ id: '1000001', title: 'Offshore Chemist' }, { id: '1000002', title: 'BIM Consultant' }])) });
  assert.equal(result.searches[0].status, 'complete');
  assert.equal(result.searches[0].endedBy, 'no_matches_fallback');
  assert.equal(result.candidates.length, 0);
  assert.equal(store.countJobs(), 0);
  store.close();
});

test('disabled searches are not requested', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([{ key: 'a', label: 'A', keywords: 'backend', location: 'Israel', enabled: false }]);
  const result = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(result.searches, []);
  store.close();
});

test('posted-age labels give a lower bound on age, and unknown labels stay unknown', () => {
  assert.equal(postedAgeLowerBoundMs('3 hours ago'), 3 * 3_600_000);
  assert.equal(postedAgeLowerBoundMs('1 minute ago'), 60_000);
  assert.equal(postedAgeLowerBoundMs('2 days ago'), 2 * 86_400_000);
  assert.equal(postedAgeLowerBoundMs('Just now'), 0);
  assert.equal(postedAgeLowerBoundMs('Reposted'), null);
  assert.equal(postedAgeLowerBoundMs(null), null);
});

test('cards older than the window are dropped and an all-old page ends pagination', async () => {
  const pages = [
    page([{ id: '1000001', ago: '2 hours ago' }, { id: '1000002', ago: '1 day ago' }]),
    page([{ id: '1000003', ago: '2 days ago' }, { id: '1000004', ago: '1 week ago' }]),
    page([{ id: '1000005', ago: '1 hour ago' }]),
  ];
  let calls = 0;
  const result = await runLinkedInSearch({ search, window, budget: createLinkedInBudget(), sleep: noSleep,
    fetchImpl: async () => { calls += 1; return response(pages.shift()); } });
  assert.deepEqual(result.cards.map((item) => item.linkedinId), ['1000001']);
  assert.equal(result.stale, 3);
  assert.equal(result.endedBy, 'older_than_window');
  assert.equal(result.status, 'complete');
  assert.equal(calls, 2);
});

test('title scope requires whole-word role terms, across English and gendered Hebrew titles', () => {
  const inScope = buildTitleIncludeFilter(['backend', 'back end', 'java', 'node.js', 'data analyst', 'מנתח נתונים', 'צד שרת']);
  for (const title of ['Senior Backend Engineer', 'Back-End Developer', 'Java Software Engineer', 'Node.js Developer',
    'Product Data Analyst', 'מנתח-ת נתונים סניור', 'מפתח/ת צד שרת']) assert.equal(inScope(title), true, title);
  for (const title of ['JavaScript Frontend Developer', 'FP&A Analyst', 'Data Scientist', 'C++ Software Engineer', 'Senior Software Engineer']) {
    assert.equal(inScope(title), false, title);
  }
  assert.equal(buildTitleIncludeFilter([])('Anything'), true);
});

test('collection keeps only titles in the combined scope of all searches', async () => {
  const store = tempStore();
  const searches = [
    { key: 'data', label: 'Data Engineering', keywords: '"data engineer"', location: 'Israel', titleIncludes: ['data engineer'] },
    { key: 'analyst', label: 'Data Analyst', keywords: '"data analyst"', location: 'Israel', titleIncludes: ['data analyst'] },
  ];
  store.syncLinkedInSearches(searches);
  const queue = [
    page([{ id: '1000001', title: 'Data Engineer' }, { id: '1000002', title: 'Product Data Analyst' }, { id: '1000003', title: 'Data Scientist' }]), '',
    page([{ id: '1000004', title: 'FP&A Analyst' }, { id: '1000005', title: 'Senior Data Analyst' }]), '',
  ];
  const result = await scanLinkedIn({ config: linkedinConfig({ searches }), store, sleep: noSleep, fetchImpl: async () => response(queue.shift()) });
  assert.deepEqual(result.candidates.map((item) => item.title), ['Data Engineer', 'Product Data Analyst', 'Senior Data Analyst']);
  assert.deepEqual(result.searches.map((row) => row.filtered), [1, 1]);
  assert.match(store.getJob(store.listPendingEvaluation()[0].jobKey).title, /Data Engineer/);
  store.close();
});

test('"no real matches" is not trusted when the same run was rate limited, so coverage stays put', async () => {
  const store = tempStore();
  store.syncLinkedInSearches([
    { key: 'a', label: 'Backend', keywords: 'backend', location: 'Israel' },
    { key: 'b', label: 'Data', keywords: '"data engineer"', location: 'Israel' },
  ]);
  const queue = [response(page([{ id: '1000001', title: 'Offshore Chemist' }, { id: '1000002', title: 'BIM Consultant' }])), response('', 429)];
  const result = await scanLinkedIn({ config: linkedinConfig(), store, sleep: noSleep, fetchImpl: async () => queue.shift() });
  assert.deepEqual(result.searches.map((row) => [row.status, row.reason]), [['failed', 'empty_unverified'], ['failed', 'rate_limited']]);
  assert.deepEqual(store.listLinkedInSearches().map((search) => search.coveredUntil), [null, null]);
  store.close();
});
