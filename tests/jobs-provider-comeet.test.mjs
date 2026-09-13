import assert from 'node:assert/strict';
import test from 'node:test';

import comeet, { parseComeetBoardUrl, parseComeetBootstrap } from '../scripts/providers/comeet.mjs';

test('comeet provider accepts only exact public board URLs', () => {
  assert.deepEqual(parseComeetBoardUrl('https://www.comeet.com/jobs/finubit/A9.002'), { slug: 'finubit', uid: 'A9.002' });
  assert.equal(parseComeetBoardUrl('https://www.comeet.com/redirect?url=http://127.0.0.1'), null);
  assert.equal(parseComeetBoardUrl('https://evil.example/jobs/finubit/A9.002'), null);
});

test('comeet provider reads ephemeral credentials and maps safe jobs', async () => {
  assert.deepEqual(parseComeetBootstrap('{"company_uid":"A9.002","token":"aaaaaaaaaaaaaaaaaaaaaa"}', 'A9.002'), {
    uid: 'A9.002', token: 'aaaaaaaaaaaaaaaaaaaaaa',
  });
  const calls = [];
  const jobs = await comeet.fetch({ name: 'Finubit', careers_url: 'https://www.comeet.com/jobs/finubit/A9.002' }, {
    async fetchText(url, options) {
      calls.push({ url, options });
      return '<script>{"company_uid": "A9.002", "token": "aaaaaaaaaaaaaaaaaaaaaa"}</script>';
    },
    async fetchJson(url, options) {
      calls.push({ url: url.replace(/token=[^&]+/, 'token=[redacted]'), options });
      return [{
        name: 'Backend Engineer',
        url_comeet_hosted_page: 'https://www.comeet.com/jobs/finubit/A9.002/backend-engineer/AA.001',
        location: { name: 'Tel Aviv' },
        time_updated: '2026-09-10T07:00:00Z',
      }, {
        name: 'Unsafe', url_active_page: 'https://127.0.0.1/internal',
      }];
    },
  });

  assert.deepEqual(jobs, [{
    title: 'Backend Engineer',
    url: 'https://www.comeet.com/jobs/finubit/A9.002/backend-engineer/AA.001',
    company: 'Finubit', location: 'Tel Aviv', postedAt: '2026-09-10T07:00:00Z',
  }]);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.options.redirect === 'error'), true);
  assert.equal(JSON.stringify(calls).includes('aaaaaaaaaaaaaaaaaaaaaa'), false);
});

test('comeet provider rejects a bootstrap for a different company uid', () => {
  assert.throws(
    () => parseComeetBootstrap('{"company_uid":"ZZ.999","token":"bbbbbbbbbbbbbbbb"}', 'A9.002'),
    /credentials were not found/,
  );
});
