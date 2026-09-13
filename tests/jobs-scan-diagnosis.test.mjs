import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScanDiagnosis } from '../scripts/dashboard/scan-diagnosis.mjs';

test('scan diagnosis turns dependency symptoms into two actionable root causes', () => {
  const diagnosis = buildScanDiagnosis({
    lastRun: {
      id: 44,
      status: 'incomplete',
      details: {
        whatsapp: {
          coverageStatus: 'incomplete',
          groups: Array.from({ length: 4 }, (_, index) => ({
            name: `Group ${index + 1}`,
            coverage: { status: 'failed', reason: 'anchor_too_old' },
          })),
        },
        processing: { totals: { links: 47, processed: 1, failed: 46, failureReasons: { browser_error: 44, scoring_failed: 2 } } },
      },
    },
    readiness: {
      browser: { status: 'blocked', code: 'sandboxed_runtime' },
      scorer: { status: 'blocked', code: 'sandboxed_runtime' },
      collector: { status: 'blocked', code: 'collector_offline' },
    },
  });

  assert.equal(diagnosis.status, 'incomplete');
  assert.equal(diagnosis.title, 'הסריקה הסתיימה חלקית');
  assert.deepEqual(diagnosis.issues.map((issue) => issue.code), [
    'sandboxed_runtime',
    'collector_offline',
  ]);
  assert.match(diagnosis.issues[0].reason, /44/);
  assert.match(diagnosis.issues[0].reason, /2/);
  assert.match(diagnosis.issues[1].reason, /4/);
});

test('successful scan diagnosis stays minimal', () => {
  const diagnosis = buildScanDiagnosis({
    lastRun: { id: 8, status: 'success', details: { processing: { totals: { links: 2, processed: 2, failed: 0 } } } },
    readiness: {},
  });

  assert.deepEqual(diagnosis, {
    status: 'success',
    title: 'הסריקה הסתיימה בהצלחה',
    summary: '2 מתוך 2 קישורים עובדו ללא כשל.',
    issues: [],
    technical: { runId: 8, codes: [] },
  });
});
