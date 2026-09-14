import assert from 'node:assert/strict';
import test from 'node:test';

import { createJobPageFetcher, knownNonJobReason } from '../scripts/jobs/fetch-page.mjs';

function memoryStore() {
  let saved = null;
  return {
    getFreshPage() { return null; },
    savePage(page) { saved = page; },
    get saved() { return saved; },
  };
}

test('HireMeTech pages use the public job API instead of requiring a browser render', async () => {
  const store = memoryStore();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      job: {
        id: 123,
        title: 'Senior Backend Engineer',
        company_name: 'Example',
        description: '<p>Build distributed Node.js services.</p>',
        requirements: ['5+ years', 'Production Node.js'],
        apply_url: 'https://example.com/careers/123',
        is_active: true,
        job_level: 'Senior',
        location: { basic: { display_name: 'Tel Aviv' }, work_model: { display_tag: 'Hybrid' } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const fetcher = createJobPageFetcher({ store, cacheTtlMs: 0, fetchImpl });

  const page = await fetcher.fetch('https://hiremetech.com/job/123?utm_source=wa');

  assert.deepEqual(calls, ['https://hiremetech.com/api/jobs/123']);
  assert.equal(page.status, 'active');
  assert.equal(page.finalUrl, 'https://example.com/careers/123');
  assert.equal(page.code, 'hiremetech_api');
  assert.match(page.content, /Senior Backend Engineer/);
  assert.match(page.content, /distributed Node\.js services/);
  assert.match(page.content, /Tel Aviv/);
  assert.equal(store.saved.status, 'active');
  await fetcher.close();
});

test('HireMeTech API failures remain retryable with a classified reason', async () => {
  const store = memoryStore();
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: 0,
    fetchImpl: async () => new Response('{"detail":"temporarily unavailable"}', { status: 503 }),
  });

  const page = await fetcher.fetch('https://hiremetech.com/he-il/job/456');

  assert.equal(page.status, 'uncertain');
  assert.equal(page.code, 'hiremetech_api_http_503');
  assert.match(page.reason, /503/);
  await fetcher.close();
});

test('known community and registration links are classified as non-jobs without fetching', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: 0,
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
  });

  const pages = await Promise.all([
    fetcher.fetch('https://hiremetech.com/communities'),
    fetcher.fetch('https://referally.link/'),
    fetcher.fetch('https://secrethunter.io/search'),
  ]);

  assert.equal(calls, 0);
  assert.deepEqual(pages.map(({ status, code }) => ({ status, code })), [
    { status: 'non-job', code: 'known_non_job_url' },
    { status: 'non-job', code: 'known_non_job_url' },
    { status: 'non-job', code: 'known_non_job_url' },
  ]);
  await fetcher.close();
});

test('known non-job hosts cover app stores, link-in-bio pages and generic Apple careers landing pages', () => {
  const nonJobUrls = [
    'https://secrethunter.io/search',
    'https://secrethunter.io/',
    'https://hire.secrethunter.io/',
    'https://play.google.com/store/apps/details?id=com.example',
    'https://apps.apple.com/us/app/example/id123456789',
    'https://linktr.ee/somecompany',
    'https://www.linktr.ee/somecompany',
    'https://jobs.apple.com/',
    'https://jobs.apple.com/en-us/search?team=apps-and-frameworks',
  ];
  for (const url of nonJobUrls) assert.ok(knownNonJobReason(url), `expected ${url} to be a known non-job URL`);

  const realPostings = [
    'https://jobs.apple.com/en-us/details/200538935/software-engineer',
    'https://boards.greenhouse.io/example/jobs/123',
  ];
  for (const url of realPostings) assert.equal(knownNonJobReason(url), null, `expected ${url} to be treated as a real posting`);
});

test('SmartRecruiters pages use the public posting API', async () => {
  const store = memoryStore();
  const calls = [];
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        id: '7440001',
        name: 'Backend Automation Engineer',
        company: { name: 'Example' },
        location: { fullLocation: 'Kfar Saba, Israel', hybrid: true },
        applyUrl: 'https://jobs.smartrecruiters.com/Example/7440001?oga=true',
        jobAd: { sections: {
          jobDescription: { text: '<p>Build backend automation in Python.</p>' },
          qualifications: { text: '<p>Distributed systems experience.</p>' },
        } },
      }), { status: 200 });
    },
  });

  const page = await fetcher.fetch('https://jobs.smartrecruiters.com/Example/7440001-backend-automation');

  assert.deepEqual(calls, ['https://api.smartrecruiters.com/v1/companies/Example/postings/7440001']);
  assert.equal(page.status, 'active');
  assert.equal(page.code, 'smartrecruiters_api');
  assert.match(page.content, /backend automation in Python/i);
  await fetcher.close();
});

test('JFrog custom Greenhouse links use the public job API', async () => {
  const store = memoryStore();
  const calls = [];
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        id: 8152802,
        title: 'Software Engineer',
        location: { name: 'Tel Aviv' },
        absolute_url: 'https://join.jfrog.com/job/?job=8152802&gh_jid=8152802',
        content: '<p>Build production backend services in Java and Go.</p>',
      }), { status: 200 });
    },
  });

  const page = await fetcher.fetch('https://join.jfrog.com/job?gh_jid=8152802&job=8152802');

  assert.deepEqual(calls, ['https://boards-api.greenhouse.io/v1/boards/jfrog/jobs/8152802?content=true']);
  assert.equal(page.status, 'active');
  assert.equal(page.code, 'greenhouse_api');
  assert.match(page.content, /production backend services/);
  await fetcher.close();
});

function fakeLivenessPage({ status, bodyText = '', applyControls = [] }) {
  // checkUrlLiveness's own evaluate() calls always run in this order: page body
  // text, then the apply-control query. fetch-page.mjs's renderedCheck makes one
  // further evaluate() call afterwards on whichever page won, to grab the final
  // content — reusing the same body text is a faithful stand-in since a real
  // page's content does not change between those calls.
  const evalResults = [bodyText, applyControls, bodyText];
  let calls = 0;
  let currentUrl = '';
  const mainFrame = {};
  return {
    async goto(url) { currentUrl = url; return { status: () => status }; },
    async waitForTimeout() {},
    url: () => currentUrl,
    async evaluate() {
      const value = evalResults[Math.min(calls, evalResults.length - 1)];
      calls += 1;
      return value;
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  };
}

function fakeChromium({ headlessPage, headedPage, headedLaunchFails = false }) {
  const launches = [];
  return {
    launches,
    async launch({ headless }) {
      launches.push(headless);
      if (!headless && headedLaunchFails) throw new Error('no display available');
      return {
        async newContext() { return { async newPage() { return headless ? headlessPage : headedPage; } }; },
        async close() {},
      };
    },
  };
}

test('a bot-blocked page is retried in a real (headed) browser and the working result wins', async () => {
  const store = memoryStore();
  const chromiumImpl = fakeChromium({
    headlessPage: fakeLivenessPage({ status: 403, bodyText: 'Access Denied' }),
    headedPage: fakeLivenessPage({
      status: 200,
      bodyText: `Senior Backend Engineer at Example. ${'Build distributed services. '.repeat(20)}`,
      applyControls: ['Apply Now'],
    }),
  });
  const fetcher = createJobPageFetcher({
    store, cacheTtlMs: 0, chromiumImpl,
    fetchImpl: async () => new Response('Access Denied', { status: 403 }),
  });

  const page = await fetcher.fetch('https://www.zoominfo.com/careers/12345');

  assert.equal(page.status, 'active');
  assert.equal(page.code, 'apply_control_visible');
  assert.match(page.content, /Senior Backend Engineer/);
  assert.deepEqual(chromiumImpl.launches, [true, false]);
  await fetcher.close();
});

test('a headed retry that is still blocked keeps the uncertain result instead of upgrading it', async () => {
  const store = memoryStore();
  const chromiumImpl = fakeChromium({
    headlessPage: fakeLivenessPage({ status: 403, bodyText: 'Access Denied' }),
    headedPage: fakeLivenessPage({ status: 403, bodyText: 'Access Denied' }),
  });
  const fetcher = createJobPageFetcher({
    store, cacheTtlMs: 0, chromiumImpl,
    fetchImpl: async () => new Response('Access Denied', { status: 403 }),
  });

  const page = await fetcher.fetch('https://www.zoominfo.com/careers/12345');

  assert.equal(page.status, 'uncertain');
  assert.equal(page.code, 'access_blocked');
  assert.match(page.reason, /headed retry also blocked/);
  await fetcher.close();
});

test('no headed browser is launched when the headless check is not a bot-challenge', async () => {
  const store = memoryStore();
  const longBody = `Some job content with plenty of text but no recognized apply control. ${'Filler. '.repeat(60)}`;
  const chromiumImpl = fakeChromium({
    headlessPage: fakeLivenessPage({ status: 200, bodyText: longBody, applyControls: [] }),
    headedPage: fakeLivenessPage({ status: 200, bodyText: longBody, applyControls: ['Apply Now'] }),
  });
  const fetcher = createJobPageFetcher({
    store, cacheTtlMs: 0, chromiumImpl,
    fetchImpl: async () => new Response(longBody, { status: 200 }),
  });

  const page = await fetcher.fetch('https://example.com/careers/12345');

  assert.equal(page.status, 'uncertain');
  assert.equal(page.code, 'no_apply_control');
  assert.deepEqual(chromiumImpl.launches, [true]);
  await fetcher.close();
});

test('substantial LinkedIn job HTML is usable when no apply control is server-rendered', async () => {
  const store = memoryStore();
  const content = `Backend Engineer at Example ${'Build distributed services. '.repeat(80)}`;
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: 0,
    fetchImpl: async () => new Response(`<html><body>${content}</body></html>`, { status: 200 }),
  });

  const page = await fetcher.fetch('https://www.linkedin.com/jobs/view/4458840528');

  assert.equal(page.status, 'active');
  assert.equal(page.code, 'linkedin_job_content');
  assert.match(page.content, /Backend Engineer/);
  await fetcher.close();
});
