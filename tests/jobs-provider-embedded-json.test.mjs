import assert from 'node:assert/strict';
import test from 'node:test';

import embeddedJson, { extractEmbeddedJsonJobs, extractJsonCandidates } from '../scripts/providers/embedded-json.mjs';

const NEXT_DATA_HTML = `
  <html><body><div id="__next"></div>
  <script id="__NEXT_DATA__" type="application/json">
  {"props":{"pageProps":{"openPositions":[
    {"title":"Senior Backend Engineer","url":"/careers/senior-backend-engineer","location":"Tel Aviv"},
    {"title":"Data Platform Engineer","url":"/careers/data-platform-engineer","location":"Remote"}
  ],"relatedArticles":[
    {"title":"Our culture","url":"/blog/culture"},
    {"title":"Why join us","url":"/blog/why-join"}
  ]}}}
  </script>
  </body></html>
`;

test('extracts a job-shaped array out of a Next.js __NEXT_DATA__ blob', () => {
  const jobs = extractEmbeddedJsonJobs(NEXT_DATA_HTML, 'https://example.com/careers', 'Example');
  assert.deepEqual(jobs, [
    { title: 'Senior Backend Engineer', url: 'https://example.com/careers/senior-backend-engineer', company: 'Example', location: 'Tel Aviv' },
    { title: 'Data Platform Engineer', url: 'https://example.com/careers/data-platform-engineer', company: 'Example', location: 'Remote' },
  ]);
});

test('ignores an unrelated title+url array that has no job key hint or location', () => {
  const html = `
    <script type="application/json" id="nav">
      {"menu":[{"title":"Products","url":"/products"},{"title":"Pricing","url":"/pricing"}]}
    </script>
  `;
  assert.deepEqual(extractEmbeddedJsonJobs(html, 'https://example.com', 'Example'), []);
});

test('accepts a job-hinted key without requiring a location field', () => {
  const html = `
    <script type="application/json">
      {"positions":[{"name":"Support Engineer","href":"/jobs/support-engineer"}]}
    </script>
  `;
  assert.deepEqual(extractEmbeddedJsonJobs(html, 'https://example.com', 'Example'), [
    { title: 'Support Engineer', url: 'https://example.com/jobs/support-engineer', company: 'Example', location: '' },
  ]);
});

test('drops job links that resolve off the page origin', () => {
  const html = `
    <script type="application/json">
      {"jobs":[{"title":"Backend Engineer","url":"https://evil.example/jobs/1","location":"Tel Aviv"}]}
    </script>
  `;
  assert.deepEqual(extractEmbeddedJsonJobs(html, 'https://example.com/careers', 'Example'), []);
});

test('picks the largest matching array when several are found', () => {
  const html = `
    <script type="application/json">
      {"featuredJobs":[{"title":"Backend Engineer","url":"/jobs/1","location":"Tel Aviv"}],
       "openPositions":[
         {"title":"Backend Engineer","url":"/jobs/1","location":"Tel Aviv"},
         {"title":"Data Engineer","url":"/jobs/2","location":"Herzliya"},
         {"title":"Platform Engineer","url":"/jobs/3","location":"Ramat Gan"}
       ]}
    </script>
  `;
  const jobs = extractEmbeddedJsonJobs(html, 'https://example.com', 'Example');
  assert.equal(jobs.length, 3);
});

test('extractJsonCandidates reads both typed script tags and bootstrap assignments', () => {
  const html = `
    <script type="application/json">{"a":1}</script>
    <script>window.__NUXT__ = {"b":2}; console.log('after');</script>
  `;
  const candidates = extractJsonCandidates(html);
  assert.deepEqual(candidates.map((c) => JSON.parse(c)), [{ a: 1 }, { b: 2 }]);
});

test('provider fetch throws when no job-shaped data is found and returns jobs otherwise', async () => {
  await assert.rejects(
    embeddedJson.fetch(
      { name: 'Example', careers_url: 'https://example.com/careers' },
      { fetchLimitedText: async () => '<h1>Careers</h1>' },
    ),
    /no job-shaped data/,
  );

  const jobs = await embeddedJson.fetch(
    { name: 'Example', careers_url: 'https://example.com/careers' },
    { fetchLimitedText: async () => NEXT_DATA_HTML },
  );
  assert.equal(jobs.length, 2);
});

test('provider never auto-detects from a bare URL', () => {
  assert.equal(embeddedJson.detect({ careers_url: 'https://example.com/careers' }), null);
});
