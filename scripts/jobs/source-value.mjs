// "Is scanning this source worth it?" — three numbers over a rolling window,
// computed from the durable facts in store.listSourceValueFacts():
//   1. yield: what each source found, how much it cost to score, what fit;
//   2. ATS company productivity: which watched companies ever produce a fit;
//   3. exclusivity: fits only one source found, and how many days earlier.

import { POSITIVE_DECISIONS as POSITIVE } from './decisions.mjs';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const SOURCE_VALUE_WINDOW_DAYS = 30;
export const SOURCE_KINDS = ['ats', 'whatsapp', 'linkedin'];
const TOP_COMPANIES = 10;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 1) {
  return value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}

export function buildSourceValue({ scans = [], sightings = [], watchedCompanies = [] } = {}, {
  now = Date.now(),
  windowDays = SOURCE_VALUE_WINDOW_DAYS,
} = {}) {
  const since = now - windowDays * DAY_MS;
  const inWindow = (at) => Number.isFinite(at) && at >= since && at <= now;

  // Per job: which sources saw it and when, plus its outcome.
  const jobs = new Map();
  for (const row of sightings) {
    const job = jobs.get(row.jobKey) || {
      seen: {}, companies: {}, scoredAt: row.firstScoredAt ?? null,
      suitableAt: row.firstSuitableAt ?? null, decision: row.decision ?? null,
    };
    job.seen[row.source] = row.firstSeenAt;
    if (row.company) job.companies[row.source] = row.company;
    jobs.set(row.jobKey, job);
  }

  // 1. Yield per source.
  const yieldRows = SOURCE_KINDS.map((source) => {
    const sourceScans = scans.filter((scan) => scan.source === source && inWindow(scan.scannedAt));
    const seenJobs = [...jobs.values()].filter((job) => inWindow(job.seen[source]));
    const suitableJobs = [...jobs.values()].filter((job) => source in job.seen && inWindow(job.suitableAt));
    const seconds = sourceScans.map((scan) => scan.seconds).filter(Number.isFinite);
    const scored = seenJobs.filter((job) => job.scoredAt != null).length;
    return {
      source,
      scans: sourceScans.length,
      medianScanSeconds: round(median(seconds)),
      found: sourceScans.reduce((total, scan) => total + scan.found, 0),
      filtered: sourceScans.reduce((total, scan) => total + scan.filteredTitle + scan.filteredLocation + scan.filteredRecency, 0),
      newJobs: seenJobs.length,
      scored,
      suitable: suitableJobs.length,
      interested: suitableJobs.filter((job) => POSITIVE.has(job.decision)).length,
      suitablePerScan: sourceScans.length ? round(suitableJobs.length / sourceScans.length, 2) : null,
      scoredPerSuitable: suitableJobs.length ? round(scored / suitableJobs.length) : null,
    };
  });

  // 2. ATS company productivity.
  const byCompany = new Map();
  for (const job of jobs.values()) {
    const company = job.companies.ats;
    if (!company || !inWindow(job.seen.ats)) continue;
    const row = byCompany.get(company) || { company, candidates: 0, suitable: 0, interested: 0 };
    row.candidates += 1;
    if (inWindow(job.suitableAt)) row.suitable += 1;
    if (POSITIVE.has(job.decision)) row.interested += 1;
    byCompany.set(company, row);
  }
  const companyRows = [...byCompany.values()];
  const normalized = (name) => String(name || '').trim().toLowerCase();
  const surfaced = new Set(companyRows.map((row) => normalized(row.company)));
  const productive = companyRows.filter((row) => row.suitable > 0)
    .sort((left, right) => right.suitable - left.suitable || right.candidates - left.candidates);
  const atsSuitable = productive.reduce((total, row) => total + row.suitable, 0);
  const topThree = productive.slice(0, 3).reduce((total, row) => total + row.suitable, 0);
  const companies = {
    watched: watchedCompanies.length,
    withCandidates: companyRows.length,
    withSuitable: productive.length,
    silent: watchedCompanies.filter((name) => !surfaced.has(normalized(name))).length,
    topShare: atsSuitable ? round(topThree / atsSuitable, 2) : null,
    top: productive.slice(0, TOP_COMPANIES),
  };

  // 3. Exclusivity and lead time among fits in the window.
  const fits = [...jobs.values()].filter((job) => inWindow(job.suitableAt));
  const exclusivity = SOURCE_KINDS.map((source) => {
    const found = fits.filter((job) => source in job.seen);
    const only = found.filter((job) => Object.keys(job.seen).length === 1);
    // Days this source was ahead of the earliest other source (negative = behind).
    const leads = found
      .filter((job) => Object.keys(job.seen).length > 1)
      .map((job) => {
        const others = Object.entries(job.seen).filter(([kind]) => kind !== source).map(([, at]) => at);
        return (Math.min(...others) - job.seen[source]) / DAY_MS;
      });
    return { source, fits: found.length, exclusive: only.length, shared: leads.length, medianLeadDays: round(median(leads)) };
  });

  return { windowDays, since, totalFits: fits.length, yield: yieldRows, companies, exclusivity };
}
