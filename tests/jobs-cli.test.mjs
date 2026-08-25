import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, scanWindow, summarizeSourceResults } from '../scripts/jobs.mjs';

test('CLI keeps the workflow small and rejects conflicting source flags', () => {
  assert.deepEqual(parseArgs(['--days', '2', '--open']), {
    days: 2,
    atsOnly: false,
    whatsappOnly: false,
    open: true,
    dryRun: false,
  });
  assert.throws(() => parseArgs(['--ats-only', '--whatsapp-only']), /either/);
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
  assert.match(summary.whatsapp.warning, /history/i);
  assert.deepEqual(summary.whatsapp.groups.map((group) => group.name), ['Group A', 'Group B']);
});
