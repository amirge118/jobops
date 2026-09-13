import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completionStatusFor,
  filterPendingCandidatesForSources,
  parseArgs,
  scanWindow,
  summarizeProcessingResults,
  summarizeSourceResults,
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
  });
  assert.deepEqual(parseArgs(['--whatsapp-backlog', '--days', '7']), {
    days: 7,
    atsOnly: false,
    whatsappOnly: false,
    open: false,
    dryRun: false,
    retryOnly: false,
    whatsappBacklog: true,
  });
  assert.throws(() => parseArgs(['--ats-only', '--whatsapp-only']), /either/);
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
    { source: 'ats', name: 'ATS', links: 1, processed: 1, suitable: 1, notSuitable: 0, failed: 0, alreadyProcessed: 0, failureReasons: {} },
    { source: 'whatsapp', name: 'Group A', links: 2, processed: 1, suitable: 0, notSuitable: 1, failed: 1, alreadyProcessed: 0, failureReasons: { page_uncertain: 1 } },
    { source: 'whatsapp', name: 'Group B', links: 2, processed: 1, suitable: 0, notSuitable: 1, failed: 0, alreadyProcessed: 1, failureReasons: {} },
  ]);
  assert.deepEqual(processing.totals, {
    links: 5,
    processed: 3,
    suitable: 1,
    notSuitable: 2,
    failed: 1,
    alreadyProcessed: 1,
    failureReasons: { page_uncertain: 1 },
  });
  assert.equal(completionStatusFor({ processing }), 'incomplete');
});
