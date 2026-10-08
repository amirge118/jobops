import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateGaps, termKey, topicOf } from '../scripts/jobs/gap-insights.mjs';

function item(overrides = {}) {
  return {
    keyword: 'Kubernetes', term: 'Kubernetes', category: 'tool', kind: 'experience_gap', importance: 'preferred',
    explanation: 'Missing.', suggestion: 'Learn it.', evidence: null,
    ...overrides,
  };
}

function rowsOf(result, topicId) {
  return result.topics.find((topic) => topic.id === topicId)?.rows || [];
}

function observation(jobKey, { items = [], employerPriorities = [], ...rest } = {}) {
  return { jobKey, company: `Co ${jobKey}`, title: 'Backend', score: 3.8, observedAt: 100, decision: null, analysis: { items, employerPriorities }, ...rest };
}

test('term keys ignore case, spacing and punctuation', () => {
  assert.equal(termKey('Node.js'), termKey('nodejs'));
  assert.equal(termKey('CI/CD'), termKey('CICD'));
  assert.equal(termKey('Prompt Engineering'), termKey('prompt-engineering'));
});

test('gaps are grouped by term inside their topic and counted per job', () => {
  const result = aggregateGaps([
    observation('a', { items: [item(), item({ term: 'Prompt Engineering', keyword: 'Prompt', category: 'keyword' })] }),
    observation('b', { items: [item({ term: 'kubernetes', importance: 'required' })] }),
    observation('c', { items: [item({ term: 'Leading teams', category: 'experience' })] }),
  ]);

  assert.deepEqual(result.totals, { jobs: 3, strongFit: 0, interested: 0, lowWeight: 0 });
  const [kubernetes] = rowsOf(result, 'scale');
  assert.equal(kubernetes.term, 'Kubernetes');
  assert.equal(kubernetes.jobs, 2);
  assert.equal(kubernetes.required, 1);
  assert.deepEqual(kubernetes.examples, ['Co a', 'Co b']);
  assert.deepEqual(rowsOf(result, 'practices').map((row) => row.term), ['Leading teams']);
  assert.deepEqual(rowsOf(result, 'ai').map((row) => row.term), ['Prompt Engineering']);
});

test('topics follow the subject, with narrow topics winning over broad ones', () => {
  const cases = {
    'Prompt Engineering': 'ai', RAG: 'ai', 'Vector Databases': 'ai', 'Vertex AI': 'ai', 'ML/LLM Lifecycle': 'ai',
    SQL: 'data', Databricks: 'data', 'ETL/ELT': 'data', Kafka: 'data',
    'Low Latency': 'scale', Concurrency: 'scale', Terraform: 'scale', AWS: 'scale',
    Go: 'languages', Scala: 'languages', 'Large-Scale Infrastructure': 'scale', Scalability: 'scale', 'C#/.NET': 'languages', 'Spring Boot': 'languages', 'Full-Stack Development': 'languages',
    'Go-to-Market': 'practices', Agile: 'practices', 'End-to-End Ownership': 'practices',
    '6+ Years': 'years', 'IVR': 'domain', 'National Cyber Defense': 'domain',
    'Something Unheard Of': 'other',
  };
  for (const [term, topic] of Object.entries(cases)) assert.equal(topicOf(term), topic, term);
});

test('topics count each job once and rank by jobs, minor topics last', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'RAG' }), item({ term: 'Prompt Engineering' })] }),
    observation('b', { items: [item({ term: 'Prompt Engineering' })] }),
    observation('c', { items: [item({ term: '5+ Years' }), item({ term: 'SQL' })] }),
    observation('d', { items: [item({ term: '7+ Years' })] }),
  ]);
  assert.deepEqual(result.topics.map((topic) => [topic.id, topic.jobs, topic.rows.length]),
    [['ai', 2, 2], ['data', 1, 1], ['years', 2, 2]]);
});

test('the learning focus takes learnable topics seen in two jobs, recurring terms first', () => {
  const result = aggregateGaps([
    observation('a', { score: 4.5, items: [item({ term: 'AI Adoption', importance: 'required' }), item({ term: 'Prompt Engineering' })] }),
    observation('b', { items: [item({ term: 'Prompt Engineering' }), item({ term: 'Agile' }), item({ term: '6+ Years' })] }),
    observation('c', { items: [item({ term: 'Agile' }), item({ term: 'SQL' }), item({ term: '4+ Years' })] }),
  ]);
  // Practices and years recur too, but they are not something to study; SQL is a single job.
  assert.deepEqual(result.focus, [{
    id: 'ai', label: 'AI ו-LLM', jobs: 2,
    terms: [{ term: 'Prompt Engineering', jobs: 2 }, { term: 'AI Adoption', jobs: 1 }],
  }]);
});

test('quick fixes are the profile-backed additions the resume does not show yet', () => {
  const result = aggregateGaps([
    observation('a', { items: [
      item({ term: 'Agile', kind: 'safe_addition', evidence: 'Scrum team.' }),
      item({ term: 'AWS', kind: 'safe_addition', evidence: 'EKS.' }),
      item({ term: 'Go' }),
    ] }),
  ], { currentResumeText: 'Built services on AWS.' });
  assert.deepEqual(result.quickFixes.map((row) => row.term), ['Agile']);
  assert.ok(result.focus.every((topic) => topic.terms.every((entry) => entry.term !== 'Agile')));
});

test('strong-fit, interested and required jobs rank a gap higher than a plain count', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'Go' })] }),
    observation('b', { items: [item({ term: 'Go' })] }),
    observation('c', { score: 4.4, decision: 'interested', items: [item({ term: 'Rust', importance: 'required' })] }),
  ]);
  // Rust: 1.5 + 1 interested + 1 required = 3.5; Go: 1 + 1 = 2.
  assert.deepEqual(rowsOf(result, 'languages').map((row) => [row.term, row.rank]), [['Rust', 3.5], ['Go', 2]]);
  assert.equal(rowsOf(result, 'languages')[0].interested, 1);
});

test('one job with profile evidence makes the gap a wording fix', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ kind: 'needs_confirmation' })] }),
    observation('b', { items: [item({ kind: 'needs_confirmation' })] }),
    observation('c', { items: [item({ kind: 'safe_addition', evidence: 'Ran EKS clusters.' })] }),
  ]);
  assert.equal(rowsOf(result, 'scale')[0].kind, 'safe_addition');
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
  assert.equal(rowsOf(result, 'languages').length, 0);
  const [scale] = rowsOf(result, 'scale');
  assert.equal(scale.jobs, 2);
  assert.equal(scale.required, 1);
  assert.deepEqual(scale.coverage, { missing: 1, partial: 1 });
});

test('terms the current resume already says are dropped, not just flagged', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'AWS' }), item({ term: 'Go' }), item({ term: 'Agile', kind: 'safe_addition' })] }),
    observation('b', { items: [item({ term: 'AWS' }), item({ term: 'Go' })] }),
  ], { currentResumeText: 'Built services on AWS with Node.js in an Agile team; good at algorithms.' });
  // "go" inside "algorithms" is not the Go language.
  assert.deepEqual(result.topics.map((topic) => [topic.id, topic.rows.map((row) => row.term)]), [['languages', ['Go']]]);
  assert.equal(result.coveredByResume, 2);
  assert.deepEqual(result.quickFixes, []);
  assert.deepEqual(result.focus.map((topic) => topic.id), ['languages']);
});

test('jobs you passed on count as demand but at low weight, below one relevant job', () => {
  const result = aggregateGaps([
    observation('a', { decision: 'not_relevant', items: [item({ term: 'IVR', importance: 'required' })] }),
    observation('b', { decision: 'too_senior', items: [item({ term: 'IVR', importance: 'required' })] }),
    observation('c', { items: [item({ term: 'Go' })] }),
  ]);
  // IVR: 2 jobs x (1 + 1 required) x 0.25 = 1; Go: one relevant job = 1. On a tie, relevant jobs win.
  const [first, second] = [...rowsOf(result, 'languages'), ...rowsOf(result, 'domain')];
  assert.deepEqual([first.term, first.rank], ['Go', 1]);
  assert.deepEqual([second.term, second.rank, second.jobs, second.lowWeight], ['IVR', 1, 2, 2]);
  assert.equal(result.totals.lowWeight, 2);
});

test('passing on a fitting role keeps full weight; only a wrong role counts faintly', () => {
  const result = aggregateGaps([
    observation('a', { decision: 'not_interested', items: [item({ term: 'Go' })] }),
    observation('b', { decision: 'company_not_interesting', items: [item({ term: 'Rust' })] }),
    observation('c', { decision: 'not_relevant', items: [item({ term: 'Scala' })] }),
    observation('d', { decision: 'applied', items: [item({ term: 'Kotlin' })] }),
  ]);
  assert.deepEqual(rowsOf(result, 'languages').map((row) => [row.term, row.rank, row.lowWeight, row.interested]),
    [['Kotlin', 2, 0, 1], ['Go', 1, 0, 0], ['Rust', 1, 0, 0], ['Scala', 0.3, 1, 0]]);
  assert.deepEqual([result.totals.interested, result.totals.lowWeight], [1, 1]);
});

test('hidden terms leave the lists; terms in progress lead their list', () => {
  const result = aggregateGaps([
    observation('a', { items: [item({ term: 'Kafka', importance: 'required' }), item({ term: 'IVR', importance: 'required' }), item({ term: 'Go' })] }),
  ], { statuses: [{ termKey: termKey('IVR'), status: 'hidden' }, { termKey: termKey('go'), status: 'in_progress' }] });

  assert.deepEqual(rowsOf(result, 'languages').map((row) => [row.term, row.status]), [['Go', 'in_progress']]);
  assert.deepEqual(rowsOf(result, 'data').map((row) => [row.term, row.status]), [['Kafka', null]]);
  assert.deepEqual(result.hidden, [{ term: 'IVR', topic: 'domain', jobs: 1 }]);
});
