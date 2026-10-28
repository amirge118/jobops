import assert from 'node:assert/strict';
import test from 'node:test';

import { createJobPageFetcher } from '../scripts/jobs/fetch-page.mjs';
import { acceptableTarget, createHireMeTechResolver, hireMeTechTarget } from '../scripts/jobs/hiremetech-resolve.mjs';

const MASKED_JOB = {
  id: 77,
  title: 'Senior Software Engineer — AI Engineering',
  company_name: '',
  company: { name: '' },
  employer_masked: true,
  apply_url: null,
  description: 'Build AI features in Node.js.',
  is_active: true,
};
const TARGET = 'https://boards.greenhouse.io/acme/jobs/9001';

function memoryStore(cached = null) {
  const targets = new Map(cached ? [['77', cached]] : []);
  const saves = [];
  return {
    saves,
    getFreshPage() { return null; },
    savePage() {},
    getHireMeTechTarget(jobId) { return targets.get(String(jobId)) || null; },
    saveHireMeTechTarget(jobId, value) { saves.push({ jobId, ...value }); },
  };
}

function fetchImpl(calls, { companyTitle = 'Senior Software Engineer — AI Engineering' } = {}) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://hiremetech.com/api/jobs/')) {
      return new Response(JSON.stringify({ job: MASKED_JOB }), { status: 200 });
    }
    if (String(url).startsWith('https://boards-api.greenhouse.io/')) {
      return new Response(JSON.stringify({
        title: companyTitle, absolute_url: TARGET,
        location: { name: 'Tel Aviv' }, content: '<p>Own the agent platform.</p>',
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function fakeResolver(outcome) {
  const calls = [];
  return {
    calls,
    async resolve(jobId) { calls.push(jobId); return outcome; },
    async close() {},
  };
}

test('a masked HireMeTech listing is scored from the company page the resolver found', async () => {
  const calls = [];
  const store = memoryStore();
  const resolver = fakeResolver({ status: 'resolved', method: 'click', company: 'Growthspace', targetUrl: TARGET });
  const fetcher = createJobPageFetcher({ store, cacheTtlMs: 0, fetchImpl: fetchImpl(calls), hireMeTech: resolver });

  const page = await fetcher.fetch('https://hiremetech.com/he-il/job/77?f=1');

  assert.equal(page.code, 'hiremetech_company_page');
  assert.equal(page.status, 'active');
  assert.equal(page.finalUrl, TARGET);
  assert.match(page.content, /^Company: Growthspace\n/);
  assert.match(page.content, /Own the agent platform/);
  assert.deepEqual(resolver.calls, ['77']);
  assert.deepEqual(store.saves.map(({ company, targetUrl, error }) => ({ company, targetUrl, error })),
    [{ company: 'Growthspace', targetUrl: TARGET, error: null }]);
  await fetcher.close();
});

test('a company page that does not name the role (an unrendered template) keeps the API text and the company link', async () => {
  const store = memoryStore();
  const resolver = fakeResolver({ status: 'resolved', method: 'click', company: 'Growthspace', targetUrl: TARGET });
  const fetcher = createJobPageFetcher({
    store, cacheTtlMs: 0, fetchImpl: fetchImpl([], { companyTitle: '{{position.name}}' }), hireMeTech: resolver,
  });

  const page = await fetcher.fetch('https://hiremetech.com/job/77');

  assert.equal(page.code, 'hiremetech_api');
  assert.equal(page.finalUrl, TARGET);
  assert.match(page.content, /^Company: Growthspace\n/);
  assert.match(page.content, /Build AI features/);
  await fetcher.close();
});

test('a signed-out resolver leaves the public API result as before and caches nothing', async () => {
  const calls = [];
  const store = memoryStore();
  const fetcher = createJobPageFetcher({
    store, cacheTtlMs: 0, fetchImpl: fetchImpl(calls), hireMeTech: fakeResolver({ status: 'logged_out' }),
  });

  const page = await fetcher.fetch('https://hiremetech.com/job/77');

  assert.equal(page.code, 'hiremetech_api');
  assert.equal(page.finalUrl, 'https://hiremetech.com/job/77');
  assert.match(page.content, /Build AI features/);
  assert.deepEqual(store.saves, []);
  assert.deepEqual(calls, ['https://hiremetech.com/api/jobs/77']);
  await fetcher.close();
});

test('a cached target is reused without pressing the apply button again', async () => {
  const calls = [];
  const store = memoryStore({ company: 'Growthspace', target_url: TARGET, method: 'click', resolved_at: Date.now() });
  const resolver = fakeResolver({ status: 'resolved', targetUrl: 'https://other.example/' });
  const fetcher = createJobPageFetcher({ store, cacheTtlMs: 0, fetchImpl: fetchImpl(calls), hireMeTech: resolver });

  const page = await fetcher.fetch('https://hiremetech.com/job/77');

  assert.equal(page.finalUrl, TARGET);
  assert.deepEqual(resolver.calls, []);
  await fetcher.close();
});

test('a recent failed attempt is not retried until a day has passed', async () => {
  const store = memoryStore({ company: null, target_url: null, error: 'no_apply_button', resolved_at: Date.now() - 60_000 });
  const resolver = fakeResolver({ status: 'resolved', company: 'X', targetUrl: TARGET });
  const fetcher = createJobPageFetcher({ store, cacheTtlMs: 0, fetchImpl: fetchImpl([]), hireMeTech: resolver });

  const page = await fetcher.fetch('https://hiremetech.com/job/77');

  assert.equal(page.code, 'hiremetech_api');
  assert.deepEqual(resolver.calls, []);
  await fetcher.close();
});

test('only a real company page counts as a target', () => {
  assert.equal(acceptableTarget('https://www.comeet.com/jobs/acme/1'), 'https://www.comeet.com/jobs/acme/1');
  assert.equal(acceptableTarget('https://hiremetech.com/job/1'), null);
  assert.equal(acceptableTarget('https://il.linkedin.com/jobs/view/1'), null);
  assert.equal(acceptableTarget('javascript:alert(1)'), null);
  assert.equal(acceptableTarget(''), null);
  assert.deepEqual(hireMeTechTarget(MASKED_JOB), { company: null, targetUrl: null, masked: true });
});

// A fake signed-in browser: the API is still masked, so the resolver presses
// the apply button once and reads the popup's address.
function fakeContext({ popupUrl = 'https://www.comeet.com/jobs/growthspace/1', apiJob = MASKED_JOB, pageUrl, signedIn = true } = {}) {
  const log = [];
  const popup = {
    url: () => popupUrl,
    waitForURL: async () => {},
    close: async () => { log.push('popup.close'); },
  };
  const button = {
    first() { return this; },
    or() { return this; },
    waitFor: async () => {},
    count: async () => 1,
    click: async () => { log.push('click'); },
  };
  const page = {
    goto: async (url) => { log.push(`goto ${url}`); },
    evaluate: async () => ({ signedIn, status: 200, payload: { job: apiJob } }),
    waitForLoadState: async () => {},
    url: () => pageUrl || 'https://hiremetech.com/job/77',
    getByRole: () => button,
    close: async () => { log.push('page.close'); },
  };
  return {
    log,
    newPage: async () => page,
    waitForEvent: async () => popup,
    close: async () => { log.push('context.close'); },
  };
}

test('the resolver presses only the apply button and closes the company page untouched', async () => {
  const context = fakeContext();
  const resolver = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => context, sleep: async () => {} });

  const outcome = await resolver.resolve('77');

  assert.deepEqual(outcome, { status: 'resolved', method: 'click', company: null, targetUrl: 'https://www.comeet.com/jobs/growthspace/1' });
  assert.deepEqual(context.log, ['goto https://hiremetech.com/', 'goto https://hiremetech.com/job/77', 'click', 'popup.close', 'page.close']);
  await resolver.close();
});

test('an unmasked signed-in API answer needs no click at all', async () => {
  const context = fakeContext({ apiJob: { ...MASKED_JOB, employer_masked: false, company_name: 'Growthspace', apply_url: TARGET } });
  const resolver = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => context, sleep: async () => {} });

  assert.deepEqual(await resolver.resolve('77'), { status: 'resolved', method: 'api', company: 'Growthspace', targetUrl: TARGET });
  assert.ok(!context.log.includes('click'));
});

test('an ATS API endpoint is not a company page, so the apply button is used instead', async () => {
  const context = fakeContext({ apiJob: { ...MASKED_JOB, employer_masked: false, company_name: 'Growthspace',
    apply_url: 'https://www.comeet.co/careers-api/2.0/company/D7.00A/positions/37.470?token=x' } });
  const resolver = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => context, sleep: async () => {} });

  assert.deepEqual(await resolver.resolve('77'),
    { status: 'resolved', method: 'click', company: 'Growthspace', targetUrl: 'https://www.comeet.com/jobs/growthspace/1' });
});

test('no session token means signed out, without pressing anything', async () => {
  const context = fakeContext({ signedIn: false });
  const resolver = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => context, sleep: async () => {} });

  assert.equal((await resolver.resolve('77')).status, 'logged_out');
  assert.ok(!context.log.includes('click'));
});

test('a login redirect marks the profile signed out and stops further attempts', async () => {
  const context = fakeContext({ pageUrl: 'https://hiremetech.com/login?next=/job/77' });
  const resolver = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => context, sleep: async () => {} });

  assert.equal((await resolver.resolve('77')).status, 'logged_out');
  assert.equal((await resolver.resolve('78')).status, 'skipped');
  assert.ok(!context.log.includes('click'));
});

test('the per-run budget and an unopenable profile are not cached as job failures', async () => {
  const budget = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => fakeContext(), maxResolves: 1, sleep: async () => {} });
  await budget.resolve('1');
  assert.equal((await budget.resolve('2')).status, 'budget');

  const locked = createHireMeTechResolver({ profilePath: '/tmp/x', launchContext: async () => { throw new Error('ProcessSingleton lock'); } });
  assert.equal((await locked.resolve('1')).status, 'unavailable');
  assert.equal((await locked.resolve('2')).status, 'skipped');
});
