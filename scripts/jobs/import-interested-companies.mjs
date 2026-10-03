#!/usr/bin/env node
// One-off catch-up: companies whose jobs you marked "interested" but that are
// not watched yet. For each one, company research (one Codex call with live
// web search) finds its careers source; a verified, scannable source is
// approved for watching right away, anything else stays a candidate for
// review on the companies page.
//
//   npm run jobs:import-interested -- --dry-run   # list only, no Codex calls
//   npm run jobs:import-interested                # research and add
//   npm run jobs:import-interested -- --limit 10

import { pathToFileURL } from 'node:url';
import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';
import { createCompanyResearcher } from './company-research.mjs';
import { normalizeCompanyIdentity } from './company-registry.mjs';

const POSITIVE = new Set(['interested', 'company_candidate']);
const VERIFIED = new Set(['verified_jobs', 'verified_empty']);

function identity(name) {
  try { return normalizeCompanyIdentity(name); } catch { return ''; }
}

// Companies to research: wanted at least once, named, not watched, not
// blocked, and not an anonymous placeholder ("Unknown", "a client of ...").
export function companiesToImport({ decisions, companies, isBlocked = () => false }) {
  const known = new Map(companies.map((company) => [identity(company.name), company]));
  const wanted = new Map();
  for (const decision of decisions) {
    if (!POSITIVE.has(decision.decision)) continue;
    const name = String(decision.company || '').trim();
    const key = identity(name);
    if (!key || key === 'unknown' || /לקוח לא מזוהה|confidential|stealth/i.test(name)) continue;
    if (known.get(key)?.status === 'watched' || known.get(key)?.status === 'ignored' || isBlocked(name)) continue;
    const row = wanted.get(key) || { name, count: 0 };
    row.count += 1;
    wanted.set(key, row);
  }
  return [...wanted.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : Infinity;
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  let targets;
  try {
    targets = companiesToImport({
      decisions: store.listJobDecisions(),
      companies: store.listCompanies({ limit: 1_000 }),
      isBlocked: (name) => store.isCompanyBlocked(name),
    }).slice(0, limit);
  } finally { store.close(); }

  console.log(`${targets.length} חברות שעניינו אותך ועדיין לא במעקב.`);
  if (dryRun) {
    for (const target of targets) console.log(`  ${target.name}${target.count > 1 ? ` (×${target.count})` : ''}`);
    return;
  }

  const research = createCompanyResearcher(config);
  const summary = { watched: [], candidate: [], failed: [] };
  for (const target of targets) {
    try {
      const result = await research(target.name);
      const store = createJobStore(config.jobsDbPath);
      try {
        const saved = store.upsertCompanyCandidate(result.candidate);
        const source = saved.sources.find((item) =>
          item.provider === result.candidate.source?.provider && item.careersUrl === result.candidate.source?.careersUrl);
        if (source && result.probe) store.recordCompanySourceProbe(source.id, result.probe, result.research?.evidenceUrls || []);
        const scannable = source && source.provider !== 'unsupported' && VERIFIED.has(result.probe?.status);
        if (scannable) {
          store.approveCompany(saved.company.id);
          summary.watched.push(`${target.name} (${source.provider}, ${result.probe.count} משרות)`);
        } else {
          store.markCompanyAsCandidate(saved.company.id);
          summary.candidate.push(`${target.name} (${result.research?.rationale || result.probe?.reason || 'לא נמצא מקור נתמך'})`);
        }
      } finally { store.close(); }
    } catch (error) {
      summary.failed.push(`${target.name}: ${error.message}`);
    }
    console.log(`  ✓ ${target.name}`);
  }
  console.log(`\nנוספו למעקב (${summary.watched.length}):\n${summary.watched.map((line) => `  ${line}`).join('\n')}`);
  console.log(`\nממתינות לבדיקה בעמוד החברות (${summary.candidate.length}):\n${summary.candidate.map((line) => `  ${line}`).join('\n')}`);
  if (summary.failed.length) console.log(`\nנכשלו (${summary.failed.length}):\n${summary.failed.map((line) => `  ${line}`).join('\n')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
