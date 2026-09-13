import assert from 'node:assert/strict';
import test from 'node:test';

import zohoRecruit, { extractZohoRecruitJobs, parseZohoRecruitBoardUrl } from '../scripts/providers/zoho-recruit.mjs';

const encodedJobs = '[{&quot;Posting_Title&quot;:&quot;Senior Backend Engineer (Data)&quot;,&quot;City&quot;:&quot;Tel Aviv&quot;,&quot;Country&quot;:&quot;Israel&quot;,&quot;id&quot;:&quot;764373000014002092&quot;,&quot;Date_Opened&quot;:&quot;2026-09-12&quot;}]';

test('Zoho Recruit extracts the generic embedded careers payload', () => {
  assert.equal(parseZohoRecruitBoardUrl('https://unit21.zohorecruit.com/jobs/Careers')?.portal, 'Careers');
  assert.deepEqual(extractZohoRecruitJobs(`<input type="hidden" value="${encodedJobs}" id="jobs">`, {
    name: 'Unit21', careers_url: 'https://unit21.zohorecruit.com/jobs/Careers',
  }), [{
    title: 'Senior Backend Engineer (Data)',
    url: 'https://unit21.zohorecruit.com/jobs/Careers/764373000014002092/Senior-Backend-Engineer-Data',
    company: 'Unit21', location: 'Tel Aviv, Israel', postedAt: '2026-09-12T00:00:00.000Z',
  }]);
});

test('Zoho Recruit uses the bounded HTML transport', async () => {
  const jobs = await zohoRecruit.fetch({ name: 'Unit21', careers_url: 'https://unit21.zohorecruit.com/jobs/Careers' }, {
    async fetchLimitedText(url, options) {
      assert.equal(url, 'https://unit21.zohorecruit.com/jobs/Careers');
      assert.equal(options.maxBytes, 3_000_000);
      return `<input id='jobs' value='${encodedJobs}'>`;
    },
  });
  assert.equal(jobs.length, 1);
});
