import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LINKEDIN_WINDOW, linkedinQueryHash, linkedinWindowSettings, nextCoveredUntil, planLinkedInWindow,
} from '../scripts/jobs/linkedin-window.mjs';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 8, 28, 9, 0); // 12:00 in Israel — windows are UTC internally
const settings = { overlapMinutes: 60, initialLookbackHours: 24, maxBackfillHours: 168 };

test('first run of a search looks back the initial window', () => {
  const plan = planLinkedInWindow({ coveredUntil: null, settings, now });
  assert.deepEqual(plan, { mode: 'auto', from: now - 24 * HOUR, to: now, basis: 'initial', contiguous: true, gap: null, warning: null });
});

test('automatic mode resumes from the last success with a small overlap', () => {
  // Morning run at 08:00 covered the night; the noon run only needs ~4h + overlap.
  const plan = planLinkedInWindow({ coveredUntil: now - 4 * HOUR, settings, now });
  assert.equal(plan.from, now - 5 * HOUR);
  assert.equal(plan.basis, 'progress');
  assert.equal(plan.gap, null);
});

test('a computer that was off catches up within the cap and reports the rest as a gap', () => {
  const coveredUntil = now - 10 * 24 * HOUR;
  const plan = planLinkedInWindow({ coveredUntil, settings, now });
  assert.equal(plan.from, now - 168 * HOUR);
  assert.deepEqual(plan.gap, { from: coveredUntil, to: now - 168 * HOUR });
  assert.equal(plan.contiguous, true);
});

test('a clock that moved backwards restarts from the initial window with a warning', () => {
  const plan = planLinkedInWindow({ coveredUntil: now + 2 * HOUR, settings, now });
  assert.equal(plan.warning, 'clock_skew');
  assert.equal(plan.from, now - 24 * HOUR);
  assert.equal(nextCoveredUntil({ plan, status: 'complete', previous: now + 2 * HOUR }), now);
});

test('small forward drift is tolerated and not treated as a clock reset', () => {
  const plan = planLinkedInWindow({ coveredUntil: now + 2 * 60_000, settings, now });
  assert.equal(plan.warning, null);
  assert.equal(plan.basis, 'progress');
});

test('manual hours define the window, capped, and only extend coverage when contiguous', () => {
  const reaching = planLinkedInWindow({ mode: 'manual', manualHours: 12, coveredUntil: now - 6 * HOUR, settings, now });
  assert.equal(reaching.from, now - 12 * HOUR);
  assert.equal(reaching.contiguous, true);
  assert.equal(nextCoveredUntil({ plan: reaching, status: 'complete', previous: now - 6 * HOUR }), now);

  const detached = planLinkedInWindow({ mode: 'manual', manualHours: 2, coveredUntil: now - 6 * HOUR, settings, now });
  assert.equal(detached.contiguous, false);
  assert.equal(nextCoveredUntil({ plan: detached, status: 'complete', previous: now - 6 * HOUR }), now - 6 * HOUR);

  const capped = planLinkedInWindow({ mode: 'manual', manualHours: 1_000, coveredUntil: null, settings, now });
  assert.equal(capped.from, now - 168 * HOUR);
  assert.throws(() => planLinkedInWindow({ mode: 'manual', manualHours: 0, settings, now }), /positive hours/);
});

test('partial or failed collections never advance coverage', () => {
  const plan = planLinkedInWindow({ coveredUntil: now - 4 * HOUR, settings, now });
  for (const status of ['partial', 'failed']) {
    assert.equal(nextCoveredUntil({ plan, status, previous: now - 4 * HOUR }), now - 4 * HOUR);
  }
  assert.equal(nextCoveredUntil({ plan, status: 'complete', previous: now - 4 * HOUR }), now);
});

test('a meaningful query change gets a new progress key; cosmetic edits do not', () => {
  const base = linkedinQueryHash({ keywords: '"data analyst"', location: 'Israel' });
  assert.equal(linkedinQueryHash({ keywords: '  "Data   Analyst" ', location: 'israel' }), base);
  assert.notEqual(linkedinQueryHash({ keywords: '"data analyst" OR "bi analyst"', location: 'Israel' }), base);
  assert.notEqual(linkedinQueryHash({ keywords: '"data analyst"', location: 'Israel', geoId: '101620260' }), base);
});

test('window settings fall back to defaults for missing or invalid values', () => {
  assert.deepEqual(linkedinWindowSettings({}), { ...DEFAULT_LINKEDIN_WINDOW });
  assert.deepEqual(
    linkedinWindowSettings({ sources: { linkedin: { overlapMinutes: 30, initialLookbackHours: -1 } } }),
    { ...DEFAULT_LINKEDIN_WINDOW, overlapMinutes: 30 },
  );
});
