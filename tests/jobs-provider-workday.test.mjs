import assert from 'node:assert/strict';
import test from 'node:test';

import workday, { parseWorkdayBoardUrl, postedOnToIso } from '../scripts/providers/workday.mjs';

test('Workday derives the tenant, site, and public job URLs from a board', async () => {
  assert.deepEqual(parseWorkdayBoardUrl('https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers'), {
    url: new URL('https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers'),
    tenant: 'mastercard', site: 'CorporateCareers', publicBasePath: '/en-US/CorporateCareers',
  });
  const calls = [];
  const jobs = await workday.fetch({
    name: 'Dynamic Yield', careers_url: 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers',
    search_text: 'Dynamic Yield',
  }, {
    async fetchLimitedText(url, options) {
      calls.push({ url, options });
      return JSON.stringify({ total: 1, jobPostings: [{
        title: 'Senior Backend Engineer', externalPath: '/job/Tel-Aviv/Senior-Backend_R-1',
        locationsText: 'Tel Aviv, Israel', postedOn: 'Posted Today',
      }] });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).searchText, 'Dynamic Yield');
  assert.equal(jobs[0].url, 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Tel-Aviv/Senior-Backend_R-1');
  assert.equal(jobs[0].location, 'Tel Aviv, Israel');
});

test('Workday converts only its bounded relative date vocabulary', () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  assert.equal(postedOnToIso('Posted 2 Days Ago', now), '2026-09-11T12:00:00.000Z');
  assert.equal(postedOnToIso('30+ Days Ago', now), '');
});
