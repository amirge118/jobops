import assert from 'node:assert/strict';
import test from 'node:test';

import officialHtml, {
  extractOfficialHtmlJobs,
  validateOfficialHtmlEntry,
} from '../scripts/providers/official-html.mjs';

test('official HTML extracts only matching same-origin job links', () => {
  const html = `
    <section><h3>Backend Engineer</h3><a href="/careers/backend-engineer"><button>Apply</button></a></section>
    <a href="/careers">Careers</a>
    <a href="/careers/privacy-policy">Privacy policy</a>
    <a href="/careers/bad%ZZ"><span aria-hidden="true">→</span></a>
    <a href="https://evil.example/careers/data-engineer">Data Engineer</a>
    <a href="javascript:alert(1)">Bad</a>
  `;
  const jobs = extractOfficialHtmlJobs(html, {
    name: 'Appcharge', careers_url: 'https://www.appcharge.com/careers',
    job_path_prefix: '/careers/', job_path_segments: 2,
    ignored_job_paths: ['/careers/privacy-policy'],
  });

  assert.deepEqual(jobs, [
    {
      title: 'Backend Engineer',
      url: 'https://www.appcharge.com/careers/backend-engineer',
      company: 'Appcharge', location: '',
    },
    {
      title: 'Bad%ZZ',
      url: 'https://www.appcharge.com/careers/bad%ZZ',
      company: 'Appcharge', location: '',
    },
  ]);
});

test('official HTML uses readable link text and URL slugs as bounded fallbacks', () => {
  const html = `
    <a href="/job/123/senior-backend-engineer"><h3>Senior Backend Engineer</h3><span>Tel Aviv · Engineering</span></a>
    <a href="/job/456/data-platform-engineer"><span aria-hidden="true">→</span></a>
  `;
  const entry = {
    name: 'Example', careers_url: 'https://careers.example.com',
    job_path_prefix: '/job/', job_path_segments: 3,
  };

  assert.deepEqual(extractOfficialHtmlJobs(html, entry).map((job) => job.title), [
    'Senior Backend Engineer', 'Data Platform Engineer',
  ]);
});

test('official HTML recognizes common position title class names used outside generic headings', () => {
  const html = `
    <a class="careers-position__link" href="/careers-position/88.E47">
      <div class="careers-position__wrapper">
        <div class="careers-position__title">Senior Backend Developer</div>
        <div class="careers-position__details">Tel Aviv · R&amp;D</div>
      </div>
    </a>
  `;
  const jobs = extractOfficialHtmlJobs(html, {
    name: 'SuperPlay', careers_url: 'https://www.superplay.co/careers/',
    job_path_prefix: '/careers-position/', job_path_segments: 2,
  });

  assert.deepEqual(jobs, [{
    title: 'Senior Backend Developer',
    url: 'https://www.superplay.co/careers-position/88.E47',
    company: 'SuperPlay', location: '',
  }]);
});

test('official HTML validates its small declarative rule and bounded fetch', async () => {
  assert.throws(() => validateOfficialHtmlEntry({
    name: 'Bad', careers_url: 'http://127.0.0.1/careers',
    job_path_prefix: '/careers/', job_path_segments: 2,
  }), /public HTTPS/);
  assert.throws(() => validateOfficialHtmlEntry({
    name: 'Bad', careers_url: 'https://example.com/careers',
    job_path_prefix: '/', job_path_segments: 0,
  }), /segment count/);

  const calls = [];
  const jobs = await officialHtml.fetch({
    name: 'Appcharge', careers_url: 'https://www.appcharge.com/careers',
    provider: 'official-html', job_path_prefix: '/careers/', job_path_segments: 2,
  }, {
    async fetchLimitedText(url, options) {
      calls.push({ url, options });
      return '<h3>Backend Engineer</h3><a href="/careers/backend-engineer">Apply</a>';
    },
  });

  assert.equal(jobs.length, 1);
  assert.deepEqual(calls, [{
    url: 'https://www.appcharge.com/careers',
    options: { redirect: 'error', timeoutMs: 15_000, maxBytes: 3_000_000 },
  }]);
});
