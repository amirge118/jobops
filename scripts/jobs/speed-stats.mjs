// How fast jobs reach the person, and what happens after "interested".
// Pure arithmetic over facts the store and tracker already hold, so it can be
// tested without a database and recomputed on every dashboard load.

import { normalizeCompanyIdentity } from './company-registry.mjs';

const HOUR_MS = 60 * 60 * 1_000;
const POSITIVE = new Set(['interested', 'company_candidate']);
const SOURCES = ['ats', 'linkedin', 'whatsapp'];
// Canonical tracker statuses (templates/states.yml) that mean "applied or later".
const OUTCOME_STATUSES = ['applied', 'responded', 'interview', 'offer', 'rejected'];

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function hours(ms) {
  return ms == null ? null : Math.round((ms / HOUR_MS) * 10) / 10;
}

function spread(values) {
  return { count: values.filter(Number.isFinite).length, medianHours: hours(quantile(values, 0.5)), p75Hours: hours(quantile(values, 0.75)) };
}

function identity(value) {
  try { return normalizeCompanyIdentity(value); } catch { return ''; }
}

function roleKey(company, title) {
  return `${identity(company)}::${String(title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
}

// Rows of data/applications.md: | # | Date | Company | Role | Score | Status | ...
export function parseTrackerRows(markdown) {
  const rows = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue;
    rows.push({ company: cells[2], role: cells[3], status: cells[5].toLowerCase() });
  }
  return rows;
}

export function buildSpeedStats({
  decisions = [],
  sightings = [],
  linkedinPostings = [],
  watchedCompanies = [],
  trackerRows = [],
} = {}) {
  // 1. Found -> decided, per source that saw the job.
  const decisionLatency = SOURCES.map((source) => ({
    source,
    ...spread(decisions
      .filter((item) => item.firstSeenAt != null && (item.sourceKinds || []).includes(source))
      .map((item) => item.decidedAt - item.firstSeenAt)),
  }));

  // 2. LinkedIn: estimated posting time -> first seen. The card label is a
  // lower bound ("5 hours ago" means 5-6h), so this is a lower bound too.
  const linkedinLag = spread(linkedinPostings
    .filter((item) => Number.isFinite(item.postedAt))
    .map((item) => Math.max(0, item.firstSeenAt - item.postedAt)));

  // 3. Which source saw the same job first, and by how much.
  const byJob = new Map();
  for (const item of sightings) {
    if (!byJob.has(item.jobKey)) byJob.set(item.jobKey, {});
    byJob.get(item.jobKey)[item.sourceKind] = item.firstSeenAt;
  }
  const firstSeen = [];
  for (const [left, right] of [['ats', 'linkedin'], ['ats', 'whatsapp'], ['whatsapp', 'linkedin']]) {
    const leads = [];
    let leftFirst = 0;
    for (const seen of byJob.values()) {
      if (seen[left] == null || seen[right] == null) continue;
      if (seen[left] <= seen[right]) leftFirst += 1;
      leads.push(seen[right] - seen[left]);
    }
    if (leads.length) firstSeen.push({ left, right, count: leads.length, leftFirst, medianLeadHours: hours(quantile(leads, 0.5)) });
  }

  // 4. Coverage: wanted jobs whose company is watched on its own board.
  const watched = new Set(watchedCompanies.map(identity).filter(Boolean));
  const positive = decisions.filter((item) => POSITIVE.has(item.decision));
  const named = positive.filter((item) => identity(item.company) && !/^unknown$/i.test(String(item.company).trim()));
  const unwatched = new Map();
  for (const item of named) {
    if (watched.has(identity(item.company))) continue;
    unwatched.set(item.company, (unwatched.get(item.company) || 0) + 1);
  }
  const coverage = {
    positive: named.length,
    watched: named.length - [...unwatched.values()].reduce((sum, count) => sum + count, 0),
    topUnwatched: [...unwatched.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
      .map(([company, count]) => ({ company, count })),
  };

  // 5. After "interested": what the tracker says happened next.
  const tracker = new Map(trackerRows.map((row) => [roleKey(row.company, row.role), row.status]));
  const outcomes = Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0]));
  let tracked = 0;
  for (const item of positive) {
    const status = tracker.get(roleKey(item.company, item.title));
    if (!status) continue;
    tracked += 1;
    if (status in outcomes) outcomes[status] += 1;
  }

  return { decisionLatency, linkedinLag, firstSeen, coverage, outcomes: { positive: positive.length, tracked, byStatus: outcomes } };
}
