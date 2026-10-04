import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { coverageKeyOf, createGapCoverageChecker, refreshGapCoverage } from '../scripts/jobs/gap-coverage.mjs';
import { aggregateGaps, termKey } from '../scripts/jobs/gap-insights.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

function item(term) {
  return { keyword: term, term, category: 'tool', kind: 'experience_gap', importance: 'preferred', explanation: 'e', suggestion: 's', evidence: null };
}

function storeWithGaps(context, terms) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-gap-coverage-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = createJobStore(path.join(tempDir, 'jobs.db'));
  context.after(() => store.close());
  const sighting = store.recordSighting({ url: 'https://example.com/jobs/1', company: 'Acme', title: 'Backend', source: 'ats', seenAt: 100 });
  store.saveEvaluation(sighting.jobKey, {
    company: 'Acme', title: 'Backend', summary: 's', score: 4.2, fitLabel: 'מתאים', decisionReason: 'r',
    suitable: true, applyUrl: sighting.canonicalUrl, activeStatus: 'active',
    contentHash: 'c', profileHash: 'p', criteriaVersion: 'v1', evaluatedAt: 200,
  });
  store.saveResumeGap(sighting.jobKey, { inputHash: 'h', analyzedAt: 300, analysis: { items: terms.map(item), employerPriorities: [] } });
  return store;
}

// Answers "covered" for the terms in coveredTerms, by the ids the prompt lists.
function fakeCodex(coveredTerms, calls) {
  return async ({ prompt, purpose, items }) => {
    calls.push({ purpose, items });
    const terms = JSON.parse(prompt.slice(prompt.lastIndexOf('Terms:\n') + 'Terms:\n'.length));
    return { results: terms.map(({ id, term }) => ({ id, covered: coveredTerms.includes(term) })) };
  };
}

const context = (resume) => ({ resumeAvailable: true, resumeHash: `hash-of-${resume}`, currentResume: resume });

test('terms the resume covers in other words are judged once per resume', async (t) => {
  const store = storeWithGaps(t, ['MCP Servers', 'RabbitMQ', 'Kafka']);
  const calls = [];
  const checker = createGapCoverageChecker({ runCodex: fakeCodex(['MCP Servers'], calls) });
  const candidate = context('Built agents with Model Context Protocol (MCP) and Kafka.');

  const first = await refreshGapCoverage({ store, checker, candidateContext: candidate });
  // Kafka is already matched as text, so Codex is asked only about the other two.
  assert.deepEqual(first, { status: 'complete', checked: 2, covered: 1 });
  assert.deepEqual(calls, [{ purpose: 'gap_coverage', items: 2 }]);
  assert.deepEqual([...store.listGapTermCoverage(coverageKeyOf(candidate.resumeHash))],
    [[termKey('MCP Servers'), true], [termKey('RabbitMQ'), false]]);

  const again = await refreshGapCoverage({ store, checker, candidateContext: candidate });
  assert.deepEqual(again, { status: 'complete', checked: 0, covered: 0 });
  assert.equal(calls.length, 1);
});

test('a new resume is judged from scratch and older answers are dropped', async (t) => {
  const store = storeWithGaps(t, ['MCP Servers']);
  const calls = [];
  const checker = createGapCoverageChecker({ runCodex: fakeCodex([], calls) });
  await refreshGapCoverage({ store, checker, candidateContext: context('Old resume text here.') });
  await refreshGapCoverage({ store, checker, candidateContext: context('New resume text here.') });
  assert.equal(calls.length, 2);
  assert.equal(store.listGapTermCoverage(coverageKeyOf('hash-of-Old resume text here.')).size, 0);
});

test('a term missing from the answer is asked about again next time', async (t) => {
  const store = storeWithGaps(t, ['MCP Servers', 'RabbitMQ']);
  const checker = createGapCoverageChecker({ runCodex: async () => ({ results: [{ id: 't1', covered: true }] }) });
  const result = await refreshGapCoverage({ store, checker, candidateContext: context('Some resume text.') });
  assert.equal(result.status, 'partial');
  assert.equal(result.checked, 1);
});

test('covered terms leave the personal area like terms the resume says verbatim', () => {
  const result = aggregateGaps([{ jobKey: 'a', score: 4, observedAt: 1, analysis: { items: [item('MCP Servers'), item('RabbitMQ')], employerPriorities: [] } }],
    { coveredTerms: new Set([termKey('MCP Servers')]) });
  assert.deepEqual(result.topics.flatMap((topic) => topic.rows.map((row) => row.term)), ['RabbitMQ']);
  assert.equal(result.coveredByResume, 1);
});

test('no resume, no Codex call', async (t) => {
  const store = storeWithGaps(t, ['MCP Servers']);
  const calls = [];
  const result = await refreshGapCoverage({
    store, checker: createGapCoverageChecker({ runCodex: fakeCodex([], calls) }),
    candidateContext: { resumeAvailable: false },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(calls.length, 0);
});
