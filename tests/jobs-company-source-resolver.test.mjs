import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCompanySourceResolver,
  extractSupportedSourceCandidates,
  fetchPublicHtml,
} from '../scripts/jobs/company-source-resolver.mjs';

test('source discovery canonicalizes ATS links embedded in an official careers page', () => {
  const html = `
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=tipaltisolutions"></script>
    <iframe src="https://jobs.ashbyhq.com/nexxen/embed"></iframe>
    <a href="https://www.comeet.com/jobs/rapyd/73.00E/backend-engineer/11.ABC">Apply</a>
    <a href="http://127.0.0.1/private">Ignore</a>
  `;

  assert.deepEqual(extractSupportedSourceCandidates(html, 'https://example.com/careers'), [
    'https://job-boards.greenhouse.io/tipaltisolutions',
    'https://jobs.ashbyhq.com/nexxen',
    'https://www.comeet.com/jobs/rapyd/73.00E',
  ]);
});

test('source discovery constructs a Comeet board URL from the classic embed widget snippet', () => {
  const html = `
    <script>
      window.comeetInit = function() {
        COMEET.init({
          "token":       "6CA28BCD941B283650365036506CA36501B28",
          "company-uid": "C6.00A",
          "company-name":"OpenLegacy",
          "css-cache": false,
        });
      };
      (function(d, s, id) { js.src = "//www.comeet.co/careers-api/api.js"; }(document, 'script', 'comeet-jsapi'));
    </script>
  `;

  assert.deepEqual(extractSupportedSourceCandidates(html, 'https://www.openlegacy.com/company/careers'), [
    'https://www.comeet.com/jobs/openlegacy/C6.00A',
  ]);
});

test('resolver follows an official page to a verified ATS source without auto-approval', async () => {
  const resolver = createCompanySourceResolver({
    fetchPage: async () => ({
      url: 'https://www.acme.example/careers',
      html: '<iframe src="https://jobs.ashbyhq.com/acme/embed"></iframe>',
    }),
    probeSource: async (source) => ({
      status: 'verified_jobs', count: 2,
      samples: [{ title: 'Backend Engineer', url: `${source.careersUrl}/job-1` }],
    }),
  });

  const result = await resolver({
    companyName: 'Acme',
    candidateUrls: ['https://www.acme.example/careers'],
    evidenceUrls: ['https://www.acme.example'],
  });

  assert.equal(result.candidate.status, 'candidate');
  assert.equal(result.candidate.source.provider, 'ashby');
  assert.equal(result.candidate.source.careersUrl, 'https://jobs.ashbyhq.com/acme');
  assert.equal(result.candidate.source.enabled, true);
  assert.equal(result.probe.status, 'verified_jobs');
  assert.equal(result.probe.count, 2);
});

test('resolver keeps a recognized but failing source disabled and explains the failure', async () => {
  const resolver = createCompanySourceResolver({
    probeSource: async () => ({
      status: 'failed', count: 0, samples: [], errorCode: 'http_404',
      reason: 'לוח המשרות החזיר HTTP 404.',
    }),
  });
  const result = await resolver({
    companyName: 'Acme',
    candidateUrls: ['https://jobs.lever.co/acme'],
    evidenceUrls: ['https://www.acme.example/careers'],
  });

  assert.equal(result.candidate.source.provider, 'lever');
  assert.equal(result.candidate.source.enabled, false);
  assert.equal(result.probe.status, 'failed');
  assert.equal(result.probe.errorCode, 'http_404');
});

test('resolver falls back to embedded-json when the page has no known ATS but carries its own job data', async () => {
  const resolver = createCompanySourceResolver({
    fetchPage: async (url) => ({
      url,
      html: '<h1>Careers</h1><script type="application/json">{"openPositions":[{"title":"Backend Engineer","url":"/jobs/1","location":"Tel Aviv"}]}</script>',
    }),
    probeSource: async (source) => ({
      status: 'verified_jobs', count: 1,
      samples: [{ title: 'Backend Engineer', url: `${source.careersUrl}/jobs/1` }],
    }),
  });
  const result = await resolver({
    companyName: 'Acme', candidateUrls: ['https://www.acme.example/careers'], evidenceUrls: [],
  });

  assert.equal(result.candidate.source.provider, 'embedded-json');
  assert.equal(result.candidate.source.enabled, true);
  assert.equal(result.probe.status, 'verified_jobs');
});

test('resolver keeps reporting needs_adapter when the embedded-json fallback also finds nothing', async () => {
  const resolver = createCompanySourceResolver({
    fetchPage: async (url) => ({ url, html: '<h1>Careers</h1>' }),
    probeSource: async () => ({
      status: 'needs_adapter', count: 0, samples: [],
      errorCode: 'provider_unsupported', reason: 'עדיין אין מתאם למקור הזה.',
    }),
  });
  const result = await resolver({
    companyName: 'Acme', candidateUrls: ['https://www.acme.example/careers'], evidenceUrls: [],
  });

  assert.equal(result.candidate.source.provider, 'unsupported');
  assert.equal(result.probe.status, 'needs_adapter');
});

test('resolver reports an official page with no supported source as needs_adapter', async () => {
  const resolver = createCompanySourceResolver({
    fetchPage: async (url) => ({ url, html: '<h1>Careers</h1>' }),
  });
  const result = await resolver({
    companyName: 'Acme', candidateUrls: ['https://www.acme.example/careers'], evidenceUrls: [],
  });

  assert.equal(result.candidate.source.provider, 'unsupported');
  assert.equal(result.candidate.source.enabled, false);
  assert.equal(result.probe.status, 'needs_adapter');
});

test('resolver scopes an acquired brand on a parent Workday board', async () => {
  let probed;
  const resolver = createCompanySourceResolver({
    probeSource: async (source) => {
      probed = source;
      return { status: 'verified_jobs', count: 1, samples: [] };
    },
  });
  const result = await resolver({
    companyName: 'Dynamic Yield',
    candidateUrls: ['https://mastercard.wd1.myworkdayjobs.com/CorporateCareers'],
    evidenceUrls: ['https://www.dynamicyield.com/careers/'],
  });
  assert.deepEqual(probed.config, { searchText: 'Dynamic Yield' });
  assert.equal(result.candidate.source.provider, 'workday');
});

test('public HTML fetch rejects redirects to private or non-HTTPS targets', async () => {
  await assert.rejects(
    fetchPublicHtml('https://public.example/careers', {
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(null, {
        status: 302, headers: { location: 'http://127.0.0.1/private' },
      }),
    }),
    /HTTPS|private|public/i,
  );
});
