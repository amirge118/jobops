import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpeedStats, parseTrackerRows } from '../scripts/jobs/speed-stats.mjs';

const H = 60 * 60 * 1000;

test('speed: found-to-decided per source, LinkedIn lag, and who saw a job first', () => {
  const speed = buildSpeedStats({
    decisions: [
      { decision: 'interested', company: 'Acme', title: 'Backend', sourceKinds: ['linkedin'], firstSeenAt: 0, decidedAt: 2 * H },
      { decision: 'not_relevant', company: 'Beta', title: 'QA', sourceKinds: ['linkedin', 'whatsapp'], firstSeenAt: 0, decidedAt: 6 * H },
    ],
    sightings: [
      { jobKey: 'a', sourceKind: 'ats', firstSeenAt: 0 }, { jobKey: 'a', sourceKind: 'linkedin', firstSeenAt: 30 * H },
      { jobKey: 'b', sourceKind: 'ats', firstSeenAt: 10 * H }, { jobKey: 'b', sourceKind: 'linkedin', firstSeenAt: 4 * H },
      { jobKey: 'c', sourceKind: 'ats', firstSeenAt: 0 }, { jobKey: 'c', sourceKind: 'linkedin', firstSeenAt: 20 * H },
    ],
    linkedinPostings: [{ postedAt: 0, firstSeenAt: 3 * H }, { postedAt: 0, firstSeenAt: 5 * H }, { postedAt: null, firstSeenAt: 1 }],
  });

  assert.deepEqual(speed.decisionLatency.find((row) => row.source === 'linkedin'), { source: 'linkedin', count: 2, medianHours: 6, p75Hours: 6 });
  assert.equal(speed.linkedinLag.count, 2);
  assert.deepEqual(speed.firstSeen, [{ left: 'ats', right: 'linkedin', count: 3, leftFirst: 2, medianLeadHours: 20 }]);
});

test('coverage counts wanted jobs from watched companies and lists the rest', () => {
  const { coverage } = buildSpeedStats({
    decisions: [
      { decision: 'interested', company: 'Acme Ltd.', title: 'A' },
      { decision: 'interested', company: 'Rubrik', title: 'B' },
      { decision: 'interested', company: 'Rubrik', title: 'C' },
      { decision: 'interested', company: 'Unknown', title: 'D' },
      { decision: 'not_relevant', company: 'Gamma', title: 'E' },
    ],
    watchedCompanies: ['acme ltd'],
  });
  assert.deepEqual(coverage, { positive: 3, watched: 1, topUnwatched: [{ company: 'Rubrik', count: 2 }] });
});

test('outcomes after "interested" come from the tracker, matched by company and role', () => {
  const rows = parseTrackerRows([
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 001 | 2026-10-01 | Acme | Senior Backend Engineer | 4.2/5 | Interview | ✅ | x | y |',
    '| 002 | 2026-10-01 | Beta | Data Engineer | 4.0/5 | Applied | ✅ | x | y |',
  ].join('\n'));
  assert.deepEqual(rows[0], { company: 'Acme', role: 'Senior Backend Engineer', status: 'interview' });

  const { outcomes } = buildSpeedStats({
    decisions: [
      { decision: 'interested', company: 'acme', title: 'Senior Backend Engineer' },
      { decision: 'interested', company: 'Gamma', title: 'X' },
    ],
    trackerRows: rows,
  });
  assert.equal(outcomes.positive, 2);
  assert.equal(outcomes.tracked, 1);
  assert.equal(outcomes.byStatus.interview, 1);
});
