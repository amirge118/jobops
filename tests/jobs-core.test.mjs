import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeJobUrl,
  calculateFitScore,
  decideFit,
  deduplicateJobs,
  normalizeCompanyRole,
} from '../scripts/jobs/core.mjs';

test('canonicalizeJobUrl removes tracking while preserving job identity', () => {
  assert.equal(
    canonicalizeJobUrl('https://EXAMPLE.com/jobs/123/?utm_source=wa&gh_src=abc&lang=en#apply'),
    'https://example.com/jobs/123?lang=en',
  );
});

test('canonicalizeJobUrl sorts meaningful query parameters', () => {
  assert.equal(
    canonicalizeJobUrl('https://example.com/apply?team=data&id=42&utm_campaign=test'),
    'https://example.com/apply?id=42&team=data',
  );
});

test('normalizeCompanyRole makes company and role comparison stable', () => {
  assert.equal(
    normalizeCompanyRole(' Lemonade ', 'Senior Back-End Engineer'),
    'lemonade::senior back end engineer',
  );
});

test('deduplicateJobs collapses equivalent URLs and company-role pairs', () => {
  const jobs = [
    { company: 'Example', title: 'Backend Engineer', applyUrl: 'https://example.com/jobs/1?utm_source=wa' },
    { company: 'Example', title: 'Backend Engineer', applyUrl: 'https://boards.example.com/abc' },
    { company: 'Other', title: 'Data Engineer', applyUrl: 'https://example.com/jobs/2' },
    { company: 'Unknown', title: 'Role', applyUrl: 'https://example.com/jobs/2?ref=feed' },
  ];

  assert.deepEqual(deduplicateJobs(jobs), [jobs[0], jobs[2]]);
});

test('calculateFitScore uses the documented simple weights', () => {
  assert.equal(
    calculateFitScore({
      cvMatch: 5,
      seniority: 4,
      roleScope: 4,
      location: 5,
      sector: 5,
    }),
    4.8,
  );
});

test('a missing core language is not an automatic blocker', () => {
  const decision = decideFit({
    score: 4.2,
    isActive: true,
    domainMatches: true,
    locationMatches: true,
    hasApplyUrl: true,
    missingSkills: ['Go'],
  });

  assert.deepEqual(decision, { suitable: true, label: 'מתאים' });
});

test('fit decision remains a simple yes/no based on score and basic gates', () => {
  assert.deepEqual(
    decideFit({ score: 4.6, isActive: true, domainMatches: true, locationMatches: true, hasApplyUrl: true }),
    { suitable: true, label: 'בול מתאים' },
  );
  assert.deepEqual(
    decideFit({ score: 3.9, isActive: true, domainMatches: true, locationMatches: true, hasApplyUrl: true }),
    { suitable: false, label: 'לא מתאים' },
  );
  assert.deepEqual(
    decideFit({ score: 5, isActive: false, domainMatches: true, locationMatches: true, hasApplyUrl: true }),
    { suitable: false, label: 'לא מתאים' },
  );
});
