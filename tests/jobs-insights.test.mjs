import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateGroupStats, aggregateSourcePerformance } from '../scripts/jobs/insights.mjs';

function run({ groups = [], scopes = [] }) {
  return { details: { whatsapp: { groups }, processing: { scopes } } };
}

test('aggregateGroupStats sums received/processed/filtered/suitable/failed across runs, per group', () => {
  const runs = [
    run({
      groups: [{ name: 'Group A', coverage: { delivered: 5 } }, { name: 'Group B', messages: 2 }],
      scopes: [
        { source: 'whatsapp', name: 'Group A', processed: 2, suitable: 1, notSuitable: 1, filtered: 1, failed: 0 },
        { source: 'whatsapp', name: 'Group B', processed: 1, suitable: 0, notSuitable: 1, filtered: 0, failed: 1 },
        { source: 'ats', name: 'ATS', processed: 3, suitable: 1, notSuitable: 2, filtered: 0, failed: 0 },
      ],
    }),
    run({
      groups: [{ name: 'Group A', coverage: { delivered: 3 } }],
      scopes: [{ source: 'whatsapp', name: 'Group A', processed: 1, suitable: 1, notSuitable: 0, filtered: 0, failed: 0 }],
    }),
  ];

  const stats = aggregateGroupStats(runs);
  assert.deepEqual(stats, [
    { name: 'Group A', received: 8, processed: 3, suitable: 2, notSuitable: 1, filtered: 1, failed: 0, runs: 2 },
    { name: 'Group B', received: 2, processed: 1, suitable: 0, notSuitable: 1, filtered: 0, failed: 1, runs: 1 },
  ]);
});

test('aggregateGroupStats tolerates runs with no WhatsApp data at all', () => {
  assert.deepEqual(aggregateGroupStats([{ details: {} }, { details: null }]), []);
});

test('aggregateSourcePerformance compares ATS and WhatsApp cost-per-suitable-job, excluding locally filtered items', () => {
  const runs = [
    run({
      scopes: [
        { source: 'ats', name: 'ATS', processed: 10, suitable: 2, notSuitable: 8, filtered: 0, failed: 1 },
        { source: 'whatsapp', name: 'Group A', processed: 20, suitable: 1, notSuitable: 19, filtered: 15, failed: 2 },
      ],
    }),
  ];

  const performance = aggregateSourcePerformance(runs);
  assert.deepEqual(performance.ats, { processed: 10, suitable: 2, notSuitable: 8, filtered: 0, failed: 1, costPerSuitable: 5 });
  assert.deepEqual(performance.whatsapp, { processed: 20, suitable: 1, notSuitable: 19, filtered: 15, failed: 2, costPerSuitable: 20 });
});

test('aggregateSourcePerformance reports null cost when a source has no suitable jobs yet', () => {
  const runs = [run({ scopes: [{ source: 'ats', name: 'ATS', processed: 5, suitable: 0, notSuitable: 5, filtered: 0, failed: 0 }] })];
  const performance = aggregateSourcePerformance(runs);
  assert.equal(performance.ats.costPerSuitable, null);
  assert.deepEqual(performance.whatsapp, { processed: 0, suitable: 0, notSuitable: 0, filtered: 0, failed: 0, costPerSuitable: null });
});
