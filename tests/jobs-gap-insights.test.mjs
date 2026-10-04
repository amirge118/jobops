import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateGaps, termKey } from '../scripts/jobs/gap-insights.mjs';

function item(overrides = {}) {
  return {
    keyword: 'Kubernetes', term: 'Kubernetes', category: 'tool', kind: 'experience_gap', importance: 'preferred',
    explanation: 'Missing.', suggestion: 'Learn it.', evidence: null,
    ...overrides,
  };
}

function observation(jobKey, { items = [], employerPriorities = [], ...rest } = {}) {
  return { jobKey, company: `Co ${jobKey}`, title: 'Backend', score: 3.8, observedAt: 100, decision: null, analysis: { items, employerPriorities }, ...rest };
}

test('term keys ignore case, spacing and punctuation', () => {
  assert.equal(termKey('Node.js'), termKey('nodejs'));
  assert.equal(termKey('CI/CD'), termKey('CICD'));
  assert.equal(termKey('Prompt Engineering'), termKey('prompt-engineering'));
});

test('gaps are grouped by term inside their category and counted per job', () => {
  const result = aggregateGaps([
    observation('a', { items: [item(), item({ term: 'Prompt Engineering', keyword: 'Prompt', category: 'keyword' })] }),
    observation('b', { items: [item({ term: 'kubernetes', importance: 'required' })] }),
    observation('c', { items: [item({ term: 'Leading teams', category: 'experience' })] }),
  ]);

  assert.deepEqual(result.totals, { jobs: 3, strongFit: 0, interested: 0, lowWeight: 0 });
  const [kubernetes] = result.sections.tool;
  assert.equal(kubernetes.term, 'Kubernetes');
  assert.equal(kubernetes.jobs, 2);
  assert.equal(kubernetes.required, 1);
  assert.deepEqual(kubernetes.examples, ['Co a', 'Co b']);
  assert.deepEqual(result.sections.experience.map((row) => row.term), ['Leading teams']);
  assert.deepEqual(result.sections.keyword.map((row) => row.term), ['Prompt Engineering']);
});

test('strong-fit, interested and required jobs rank a gap higher than a plain count', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'Go' })] }),
    observation('b', { items: [item({ term: 'Go' })] }),
    observation('c', { score: 4.4, decision: 'interested', items: [item({ term: 'Rust', importance: 'required' })] }),
  ]);
  // Rust: 1.5 + 1 interested + 1 required = 3.5; Go: 1 + 1 = 2.
  assert.deepEqual(result.sections.tool.map((row) => [row.term, row.rank]), [['Rust', 3.5], ['Go', 2]]);
  assert.equal(result.sections.tool[0].interested, 1);
});

test('one job with profile evidence makes the gap a wording fix', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ kind: 'needs_confirmation' })] }),
    observation('b', { items: [item({ kind: 'needs_confirmation' })] }),
    observation('c', { items: [item({ kind: 'safe_addition', evidence: 'Ran EKS clusters.' })] }),
  ]);
  assert.equal(result.sections.tool[0].kind, 'safe_addition');
});

test('employer priorities add uncovered phrases; strongly covered ones are not gaps', () => {
  const result = aggregateGaps([
    observation('a', { employerPriorities: [
      { priority: 'High-scale systems', term: 'High scale', weight: 'critical', coverage: 'missing', note: 'Not shown.' },
      { priority: 'Python', term: 'Python', weight: 'critical', coverage: 'strong', note: 'Shown.' },
    ] }),
    observation('b', {
      items: [item({ term: 'High Scale', category: 'experience' })],
      employerPriorities: [{ priority: 'Scale', term: 'high-scale', weight: 'important', coverage: 'partial', note: 'Weak.' }],
    }),
  ]);
  assert.equal(result.sections.keyword.length, 0);
  const [scale] = result.sections.experience;
  assert.equal(scale.jobs, 2);
  assert.equal(scale.required, 1);
  assert.deepEqual(scale.coverage, { missing: 1, partial: 1 });
});

test('terms already in the resume are flagged and sorted last', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'AWS' }), item({ term: 'Go' })] }),
    observation('b', { items: [item({ term: 'AWS' })] }),
  ], { currentResumeText: 'Built services on AWS with Node.js; good at algorithms.' });
  assert.deepEqual(result.sections.tool.map((row) => [row.term, row.inResume]), [['Go', false], ['AWS', true]]);
});

test('jobs you passed on count as demand but at low weight, below one relevant job', () => {
  const result = aggregateGaps([
    observation('a', { decision: 'not_relevant', items: [item({ term: 'IVR', importance: 'required' })] }),
    observation('b', { decision: 'too_senior', items: [item({ term: 'IVR', importance: 'required' })] }),
    observation('c', { items: [item({ term: 'Go' })] }),
  ]);
  // IVR: 2 jobs x (1 + 1 required) x 0.25 = 1; Go: one relevant job = 1. On a tie, relevant jobs win.
  const [first, second] = result.sections.tool;
  assert.deepEqual([first.term, first.rank], ['Go', 1]);
  assert.deepEqual([second.term, second.rank, second.jobs, second.lowWeight], ['IVR', 1, 2, 2]);
  assert.equal(result.totals.lowWeight, 2);
});
