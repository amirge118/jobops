import { runPortalScan } from '../../scan.mjs';
import { normalizeCompanyIdentity } from '../company-registry.mjs';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-company ATS progress. Each company starts from its own last successful
 * scan (minus the overlap), never later than the shared window and never
 * earlier than the max lookback. So a company that failed catches up on its
 * own next time, and its failure no longer has to hold back every other
 * company's window. Companies that never succeeded use the shared window.
 */
export function companyLookbackHours({ lastSuccessAt, sharedFrom, now, overlapMs, maxLookbackMs }) {
  const from = lastSuccessAt == null ? sharedFrom : Math.min(sharedFrom, lastSuccessAt - overlapMs);
  return Math.ceil((now - Math.max(from, now - maxLookbackMs)) / HOUR_MS);
}

export async function scanAts({ store, lookbackHours, companyWindow = null, runScan = runPortalScan }) {
  // The unified SQLite store owns dedup. Legacy pipeline/history files must not
  // hide jobs that have never reached the unified evaluation flow.
  const args = ['--dry-run', '--quiet', '--ignore-history'];
  if (Number.isFinite(lookbackHours)) args.push(`--max-age=${lookbackHours}`);

  const watchedCompanies = typeof store.listWatchedCompanySources === 'function'
    ? store.listWatchedCompanySources()
    : [];
  const lastSuccess = companyWindow && typeof store.getCompanyLastSuccessTimes === 'function'
    ? store.getCompanyLastSuccessTimes()
    : null;
  const catchUp = new Map();
  const options = { additionalCompanies: watchedCompanies };
  if (lastSuccess) {
    options.maxAgeHoursFor = (name) => {
      const hours = companyLookbackHours({ ...companyWindow, lastSuccessAt: lastSuccess.get(normalizeCompanyIdentity(name)) ?? null });
      if (hours > lookbackHours) catchUp.set(name, hours);
      return hours;
    };
  }
  const result = await runScan(args, options);
  if (typeof store.recordCompanyScanResults === 'function') {
    store.recordCompanyScanResults({
      scannedNames: watchedCompanies.map((company) => company.name),
      errorNames: (result.errors || []).map((error) => error.company),
    });
  }
  const candidates = [];
  for (const offer of result.offers) {
    const sighting = store.recordSighting({
      url: offer.url,
      company: offer.company,
      title: offer.title,
      source: `ATS: ${offer.source}`,
    });
    candidates.push({
      ...sighting,
      url: offer.url,
      company: offer.company,
      title: offer.title,
      location: offer.location ?? '',
      postedAt: offer.postedAt ?? null,
      source: `ATS: ${offer.source}`,
    });
  }

  const byKey = new Map();
  for (const candidate of candidates) {
    // A second sighting in this same run must not erase its first-seen status.
    byKey.set(candidate.jobKey, { ...candidate, isNew: Boolean(candidate.isNew || byKey.get(candidate.jobKey)?.isNew) });
  }
  const unique = [...byKey.values()];
  return { source: 'ats', candidates, stats: result.stats, errors: result.errors,
    catchUp: [...catchUp].map(([company, hours]) => ({ company, hours })),
    discovery: { found: unique.length, new: unique.filter((candidate) => candidate.isNew).length, known: unique.filter((candidate) => !candidate.isNew).length } };
}
