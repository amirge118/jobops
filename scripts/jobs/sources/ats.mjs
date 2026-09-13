import { runPortalScan } from '../../scan.mjs';

export async function scanAts({ store, lookbackHours, runScan = runPortalScan }) {
  // The unified SQLite store owns dedup. Legacy pipeline/history files must not
  // hide jobs that have never reached the unified evaluation flow.
  const args = ['--dry-run', '--quiet', '--ignore-history'];
  if (Number.isFinite(lookbackHours)) args.push(`--max-age=${lookbackHours}`);

  const watchedCompanies = typeof store.listWatchedCompanySources === 'function'
    ? store.listWatchedCompanySources()
    : [];
  const result = await runScan(args, { additionalCompanies: watchedCompanies });
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
    discovery: { found: unique.length, new: unique.filter((candidate) => candidate.isNew).length, known: unique.filter((candidate) => !candidate.isNew).length } };
}
