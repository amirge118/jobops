import assert from 'node:assert/strict';
import test from 'node:test';

import teamme, { extractTeamMeJobs, parseTeamMeBoardUrl } from '../scripts/providers/teamme.mjs';

const posting = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Backend Engineer',
  url: 'https://www.example.com/position/42', datePosted: '2026-09-12T10:00:00.000Z',
  hiringOrganization: { name: 'Example', sameAs: 'https://www.example.com/careers' },
  jobLocation: { address: { addressLocality: 'Herzliya' } },
});

test('TeamMe reads generic JobPosting data and validates the external company host', () => {
  assert.equal(parseTeamMeBoardUrl('https://example.teamme.link/')?.slug, 'example');
  const html = `<script type="application/ld+json">${posting}</script>`;
  assert.deepEqual(extractTeamMeJobs(html, { name: 'Example', careers_url: 'https://example.teamme.link' }), [{
    title: 'Backend Engineer', url: 'https://www.example.com/position/42', company: 'Example',
    location: 'Herzliya', postedAt: '2026-09-12T10:00:00.000Z',
  }]);

  const unsafe = posting.replace('www.example.com/position/42', 'evil.example/position/42');
  assert.throws(() => extractTeamMeJobs(`<script type="application/ld+json">${unsafe}</script>`, {
    name: 'Example', careers_url: 'https://example.teamme.link',
  }), /no valid JobPosting/);
});

test('TeamMe uses the bounded HTML transport', async () => {
  const jobs = await teamme.fetch({ name: 'Example', careers_url: 'https://example.teamme.link' }, {
    async fetchLimitedText(url, options) {
      assert.equal(url, 'https://example.teamme.link/');
      assert.equal(options.maxBytes, 3_000_000);
      return `<script type="application/ld+json">${posting}</script>`;
    },
  });
  assert.equal(jobs.length, 1);
});
