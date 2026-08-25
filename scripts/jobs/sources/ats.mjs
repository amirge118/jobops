import { runPortalScan } from '../../scan.mjs';

export async function scanAts({ store, lookbackHours, runScan = runPortalScan }) {
  // The unified SQLite store owns dedup. Legacy pipeline/history files must not
  // hide jobs that have never reached the unified evaluation flow.
  const args = ['--dry-run', '--quiet', '--ignore-history'];
  if (Number.isFinite(lookbackHours)) args.push(`--max-age=${lookbackHours}`);

  const result = await runScan(args);
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

  return { source: 'ats', candidates, stats: result.stats, errors: result.errors };
}
