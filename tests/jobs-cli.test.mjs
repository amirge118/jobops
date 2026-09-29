import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completionStatusFor,
  filterPendingCandidatesForSources,
  parseArgs,
  processingScope,
  scanWindow,
  summarizeProcessingResults,
  summarizeSourceResults,
  windowStatusFor,
} from '../scripts/jobs.mjs';

test('source-only scans do not pull failed work from the other source', () => {
  const pending = [
    { jobKey: 'ats', source: 'ATS: greenhouse-api' },
    { jobKey: 'wa', source: 'WhatsApp: Group A' },
    { jobKey: 'unknown', source: 'retry' },
  ];

  assert.deepEqual(filterPendingCandidatesForSources(pending, ['ats']), [pending[0]]);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['whatsapp']), [pending[1]]);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['ats', 'whatsapp']), pending);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['retry']), pending);
});

test('CLI keeps the workflow small and rejects conflicting source flags', () => {
  assert.deepEqual(parseArgs(['--days', '2', '--open']), {
    days: 2,
    atsOnly: false,
    whatsappOnly: false,
    open: true,
    dryRun: false,
    retryOnly: false,
    whatsappBacklog: false,
    linkedinOnly: false,
    linkedinHours: null,
    waitForLockMinutes: null,
  });
  assert.deepEqual(parseArgs(['--whatsapp-backlog', '--days', '7']), {
    days: 7,
    atsOnly: false,
    whatsappOnly: false,
    open: false,
    dryRun: false,
    retryOnly: false,
    whatsappBacklog: true,
    linkedinOnly: false,
    linkedinHours: null,
    waitForLockMinutes: null,
  });
  assert.throws(() => parseArgs(['--ats-only', '--whatsapp-only']), /only one source-only flag/);
  assert.throws(() => parseArgs(['--linkedin-only', '--ats-only']), /only one source-only flag/);
  assert.throws(() => parseArgs(['--retry-only', '--linkedin-only']), /retry-only/);
  assert.throws(() => parseArgs(['--ats-only', '--linkedin-hours', '6']), /linkedin-hours/);
  assert.throws(() => parseArgs(['--linkedin-hours', '0']), /positive/);
  assert.throws(() => parseArgs(['--wait-for-lock', '500']), /up to 120/);
  assert.deepEqual(
    (({ linkedinOnly, linkedinHours, waitForLockMinutes }) => ({ linkedinOnly, linkedinHours, waitForLockMinutes }))(
      parseArgs(['--linkedin-only', '--linkedin-hours', '6', '--wait-for-lock', '20'])),
    { linkedinOnly: true, linkedinHours: 6, waitForLockMinutes: 20 },
  );
  assert.throws(() => parseArgs(['--retry-only', '--whatsapp-only']), /retry-only/);
  assert.throws(() => parseArgs(['--whatsapp-backlog', '--ats-only']), /whatsapp-backlog/);
});

test('scan window uses last successful run with overlap and caps explicit days', () => {
  const config = { scan: { maxLookbackDays: 14, defaultLookbackDays: 2, overlapHours: 12 } };
  const now = Date.UTC(2026, 7, 24);
  const store = {
    getLastSuccessfulRun(sources) {
      assert.deepEqual(sources, ['ats', 'whatsapp']);
      return { finished_at: now - 24 * 60 * 60 * 1000 };
    },
  };

  assert.equal(
    scanWindow({ config, store, sources: ['ats', 'whatsapp'], now }).from,
    now - 36 * 60 * 60 * 1000,
  );
  assert.equal(
    scanWindow({ config, store, requestedDays: 30, sources: ['ats', 'whatsapp'], now }).from,
    now - 14 * 24 * 60 * 60 * 1000,
  );
});

test('source summary makes an empty WhatsApp history visible', () => {
  const summary = summarizeSourceResults([
    {
      source: 'ats',
      candidates: [],
      stats: { companies: 24, totalFound: 100, filteredTitle: 70, filteredLocation: 10, filteredRecency: 20 },
      errors: [],
    },
    {
      source: 'whatsapp',
      candidates: [],
      groups: [
        { name: 'Group A', found: true, messages: 0, candidates: 0, error: null },
        { name: 'Group B', found: true, messages: 0, candidates: 0, error: null },
      ],
    },
  ]);

  assert.equal(summary.ats.candidates, 0);
  assert.deepEqual(summary.ats.filtered, { title: 70, location: 10, recency: 20 });
  assert.equal(summary.whatsapp.messages, 0);
  assert.equal(summary.whatsapp.receivedMessages, 0);
  assert.match(summary.whatsapp.warning, /history/i);
  assert.equal(summary.whatsapp.coverageStatus, 'incomplete');
  assert.deepEqual(
    summary.whatsapp.groups.map((group) => group.coverage.status),
    ['unknown', 'unknown'],
  );
  assert.equal(completionStatusFor(summary), 'incomplete');
  assert.deepEqual(summary.whatsapp.groups.map((group) => group.name), ['Group A', 'Group B']);
});

test('run is successful only when every included WhatsApp group covers the requested window', () => {
  const summary = summarizeSourceResults([{
    source: 'whatsapp',
    candidates: [],
    diagnostics: { historyEvents: 2, upsertEvents: 0, messages: 120 },
    groups: [
      {
        name: 'Group A', found: true, messages: 70, candidates: 10, error: null,
        coverage: { status: 'complete', oldestAt: 100, newestAt: 200, requestedFrom: 100 },
        read: { marked: true, method: 'message-receipts', messages: 70 },
      },
      {
        name: 'Group B', found: true, messages: 50, candidates: 8, error: null,
        coverage: { status: 'complete', oldestAt: 100, newestAt: 210, requestedFrom: 100 },
      },
    ],
  }]);

  assert.equal(summary.whatsapp.coverageStatus, 'complete');
  assert.equal(summary.whatsapp.receivedMessages, 120);
  assert.equal(summary.whatsapp.warning, null);
  assert.deepEqual(summary.whatsapp.groups[0].read, {
    marked: true,
    method: 'message-receipts',
    messages: 70,
    unreadBefore: null,
    error: null,
  });
  assert.equal(completionStatusFor(summary), 'success');
});

test('link processing is summarized independently for ATS and each WhatsApp group', () => {
  const candidates = [
    { jobKey: 'a', source: 'ATS: greenhouse' },
    { jobKey: 'b', source: 'WhatsApp: Group A' },
    { jobKey: 'b', source: 'WhatsApp: Group A' },
    { jobKey: 'c', source: 'WhatsApp: Group A' },
    { jobKey: 'b', source: 'WhatsApp: Group B' },
    { jobKey: 'd', source: 'WhatsApp: Group B' },
  ];
  const outcomes = new Map([
    ['a', { status: 'suitable' }],
    ['b', { status: 'not-suitable' }],
    ['c', { status: 'failed', code: 'page_uncertain' }],
    ['d', { status: 'already-processed' }],
  ]);

  const processing = summarizeProcessingResults(candidates, outcomes);

  assert.deepEqual(processing.scopes, [
    { source: 'ats', name: 'ATS', links: 1, processed: 1, suitable: 1, notSuitable: 0, failed: 0, alreadyProcessed: 0, filtered: 0, failureReasons: {} },
    { source: 'whatsapp', name: 'Group A', links: 2, processed: 1, suitable: 0, notSuitable: 1, failed: 1, alreadyProcessed: 0, filtered: 0, failureReasons: { page_uncertain: 1 } },
    { source: 'whatsapp', name: 'Group B', links: 2, processed: 1, suitable: 0, notSuitable: 1, failed: 0, alreadyProcessed: 1, filtered: 0, failureReasons: {} },
  ]);
  assert.deepEqual(processing.totals, {
    links: 5,
    processed: 3,
    suitable: 1,
    notSuitable: 2,
    failed: 1,
    alreadyProcessed: 1,
    filtered: 0,
    failureReasons: { page_uncertain: 1 },
  });
  assert.equal(completionStatusFor({ processing }), 'incomplete');
});

test('LinkedIn pending work is only read when LinkedIn is part of the run', () => {
  const pending = [
    { jobKey: 'ats', source: 'ATS: greenhouse-api' },
    { jobKey: 'wa', source: 'WhatsApp: Group A' },
    { jobKey: 'li', source: 'LinkedIn: Backend' },
  ];
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['ats', 'whatsapp']).map((job) => job.jobKey), ['ats', 'wa']);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['ats', 'whatsapp', 'linkedin']).map((job) => job.jobKey), ['ats', 'wa', 'li']);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['linkedin']).map((job) => job.jobKey), ['li']);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['retry'], { linkedinEnabled: false }).map((job) => job.jobKey), ['ats', 'wa']);
  assert.deepEqual(filterPendingCandidatesForSources(pending, ['retry'], { linkedinEnabled: true }).map((job) => job.jobKey), ['ats', 'wa', 'li']);
});

test('LinkedIn sightings get their own processing scope per search, not ATS', () => {
  assert.deepEqual(processingScope({ source: 'LinkedIn: Data Analyst' }), { source: 'linkedin', name: 'Data Analyst' });
  assert.deepEqual(processingScope({ source: 'ATS: lever-api' }), { source: 'ats', name: 'ATS' });
  const processing = summarizeProcessingResults(
    [{ jobKey: 'a', source: 'LinkedIn: Backend' }, { jobKey: 'b', source: 'LinkedIn: Backend' }],
    new Map([['a', { status: 'suitable' }], ['b', { status: 'failed', code: 'linkedin_deferred' }]]),
  );
  assert.deepEqual(processing.scopes.map(({ source, name, links, suitable, failed }) => ({ source, name, links, suitable, failed })), [
    { source: 'linkedin', name: 'Backend', links: 2, suitable: 1, failed: 1 },
  ]);
});

test('a LinkedIn shortfall marks the run incomplete without holding back the ATS/WhatsApp window', () => {
  const summary = summarizeSourceResults([
    { source: 'ats', candidates: [], stats: { companies: 1, totalFound: 0 }, errors: [] },
    { source: 'linkedin', candidates: [], requests: 1, haltedBy: 'blocked', errors: [],
      searches: [{ id: 1, label: 'Backend', status: 'failed', reason: 'blocked', found: 0, new: 0, known: 0, filtered: 0 }] },
  ]);
  summary.processing = {
    totals: { failed: 2 },
    scopes: [{ source: 'linkedin', name: 'Backend', failed: 2 }],
  };
  assert.equal(summary.linkedin.coverageStatus, 'incomplete');
  assert.equal(completionStatusFor(summary), 'incomplete');
  assert.equal(windowStatusFor(summary), 'success');

  summary.processing.scopes.push({ source: 'ats', name: 'ATS', failed: 1 });
  assert.equal(windowStatusFor(summary), 'incomplete');
});

test('a source-level LinkedIn crash is reported as a failure, never as zero jobs', () => {
  const summary = summarizeSourceResults([
    { source: 'linkedin', candidates: [], searches: [], errors: [], failure: { code: 'network_error', reason: 'x' } },
  ]);
  assert.equal(summary.linkedin.coverageStatus, 'incomplete');
  assert.equal(completionStatusFor(summary), 'incomplete');
});
