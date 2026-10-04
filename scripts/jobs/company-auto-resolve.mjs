#!/usr/bin/env node
// Daily, unattended resolution of candidate companies. Each candidate ends in
// exactly one of two places:
//   - watched: a source that returned jobs AND evidently belongs to the
//     company (its board name or host matches the company, or it was found
//     on the company's own careers site), marked as added automatically;
//   - "cannot be scanned": a reason code the companies page explains in plain
//     words, retried automatically after RETRY_DAYS.
// A candidate is resolved in three steps: Codex research when it was never
// researched; then, for each careers page, a rendered visit that reads the
// ATS links in the page, the ATS API calls the page makes in the background,
// and a repeated job-link pattern on the site itself; then one hop to an
// "open positions" page when the first page held none of those.
//
//   npm run jobs:companies:resolve              # every due candidate
//   npm run jobs:companies:resolve -- --dry-run # report only, change nothing
//   npm run jobs:companies:resolve -- --company Guesty

import { pathToFileURL } from 'node:url';
import { detectCompanyJobSource, normalizeCompanyIdentity, normalizeCompanySource } from './company-registry.mjs';
import { extractSupportedSourceCandidates, probeCompanySource } from './company-source-resolver.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETRY_DAYS = 14;
const MAX_PAGES = 3;
const MIN_PATTERN_LINKS = 3;
const AGGREGATOR_BOARDS = 3;
const VERIFIED = new Set(['verified_jobs', 'verified_empty']);

// Words that say nothing about which company a board belongs to.
const GENERIC_NAME_WORDS = new Set([
  'the', 'inc', 'ltd', 'llc', 'corp', 'co', 'company', 'group', 'technologies', 'technology', 'tech',
  'software', 'systems', 'solutions', 'networks', 'labs', 'security', 'io', 'ai', 'global', 'israel',
  'international', 'holdings', 'partners', 'services', 'digital', 'data', 'cloud', 'team', 'one',
]);

// Hosts that publish other companies' jobs; a careers "page" there tells
// nothing about the company's own source.
const JOB_BOARD_HOSTS = /(^|\.)(linkedin\.com|hiremetech\.com|alljobs\.co\.il|drushim\.co\.il|jobmaster\.co\.il|glassdoor\.[a-z.]+|indeed\.[a-z.]+|wellfound\.com|builtin\.com|startup\.jobs|k1\.com|getro\.com)$/i;

// Recruiting platforms seen in pages but without an adapter here.
const UNSUPPORTED_PLATFORMS = [
  [/oraclecloud\.com|\/sites\/cx_\d+\/jobs/i, 'Oracle Recruiting'],
  [/icims\.com/i, 'iCIMS'],
  [/jobvite\.com/i, 'Jobvite'],
  [/taleo\.net/i, 'Taleo'],
  [/successfactors\.(com|eu)|jobs\.sap\.com/i, 'SAP SuccessFactors'],
  [/bamboohr\.com/i, 'BambooHR'],
  [/teamtailor\.com/i, 'Teamtailor'],
  [/personio\.(de|com)/i, 'Personio'],
  [/hibob\.com/i, 'HiBob'],
  [/breezy\.hr/i, 'Breezy'],
  [/pinpointhq\.com/i, 'Pinpoint'],
  [/rippling\.com\/.*jobs|ats\.rippling\.com/i, 'Rippling'],
];

// Path sections that hold many links but are never job listings.
const NON_JOB_SECTIONS = /^\/(?:blog|news|press|features?|products?|solutions?|services?|resources?|resources-category|tools|docs?|info|quote|events?|webinars?|customers?|partners?|industries|legal|category|tag|author|integrations?|use-cases?|company|about|help|support|investors?|investor-relations|ir|governance|financials?|leadership|management|board|team|people|case-studies|stories)\b/i;
const JOB_SECTION = /career|job|position|opening|vacanc|join|hiring|משרות|דרושים/i;
const ROLE_TEXT = /engineer|developer|manager|analyst|designer|architect|scientist|lead|director|specialist|product|sales|marketing|r&d|backend|frontend|devops|qa|support|recruit|accountant|administrator|מפתח|מהנדס|מנהל/i;
const OPEN_POSITIONS_LINK = /open[\s-]*(positions|roles|jobs)|all[\s-]*(jobs|positions|openings)|current[\s-]*openings|job[\s-]*openings|view[\s-]*(all[\s-]*)?(jobs|positions|openings)|see[\s-]*(our[\s-]*)?open|careers-open-positions|משרות[\s-]*פתוחות|לכל[\s-]*המשרות/i;

function identity(value) {
  try { return normalizeCompanyIdentity(value); } catch { return ''; }
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function companyNameTokens(name) {
  const words = identity(name).split(' ').filter((word) => word.length >= 3 && !GENERIC_NAME_WORDS.has(word));
  const tokens = new Set(words.map(compact).filter((word) => word.length >= 3));
  const joined = compact(words.join(''));
  if (joined.length >= 4) tokens.add(joined);
  return [...tokens];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function nameMatches(text, tokens) {
  const value = compact(text);
  return tokens.some((token) => value.includes(token));
}

// A source "belongs" when its own board name or host names the company. Job
// links read off a careers site (official-html) also belong when that site's
// host names the company. An ATS board merely embedded in the company's site
// does not: a portfolio company's site can embed its investor's whole board
// (Lumia Security's page shows Team8's Comeet board), so a board must carry
// the company's own name.
export function sourceBelongsToCompany({ source, companyName, discoveredOn = null, aggregator = false }) {
  const tokens = companyNameTokens(companyName);
  if (!tokens.length) return false;
  if (nameMatches(source.boardKey, tokens) || nameMatches(hostOf(source.careersUrl), tokens)) return true;
  if (source.provider === 'comeet' && nameMatches(source.careersUrl, tokens)) return true;
  return source.provider === 'official-html' && Boolean(discoveredOn) && !aggregator &&
    nameMatches(hostOf(discoveredOn), tokens);
}

export function isJobBoardUrl(url) {
  return JOB_BOARD_HOSTS.test(hostOf(url));
}

export function unsupportedPlatformIn(values) {
  for (const value of values) {
    for (const [pattern, name] of UNSUPPORTED_PLATFORMS) if (pattern.test(String(value))) return name;
  }
  return null;
}

// ATS API calls made in the background, mapped to the board URL a provider
// understands. Comeet needs one extra call (see comeetBoardFromApi).
export function boardUrlsFromRequests(requests) {
  const boards = new Set();
  const comeetApis = new Set();
  for (const raw of requests) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    const segments = url.pathname.split('/').filter(Boolean);
    const host = url.hostname.toLowerCase();
    if (host === 'www.comeet.co' && segments[0] === 'careers-api' && url.searchParams.get('token')) {
      comeetApis.add(`https://www.comeet.co/careers-api/2.0/company/${segments[3]}/positions?token=${url.searchParams.get('token')}`);
    } else if (host === 'api.lever.co' && segments[1] === 'postings' && segments[2]) {
      boards.add(`https://jobs.lever.co/${segments[2]}`);
    } else if (host === 'api.ashbyhq.com' && segments[0] === 'posting-api' && segments[2]) {
      boards.add(`https://jobs.ashbyhq.com/${segments[2]}`);
    } else if (host === 'api.smartrecruiters.com' && segments[1] === 'companies' && segments[2]) {
      boards.add(`https://jobs.smartrecruiters.com/${segments[2]}`);
    } else if (host === 'apply.workable.com' && segments[0] === 'api' && segments[3]) {
      boards.add(`https://apply.workable.com/${segments[3]}`);
    }
  }
  for (const url of extractSupportedSourceCandidates(requests.join('\n'), 'https://example.invalid/')) boards.add(url);
  return { boards: [...boards], comeetApis: [...comeetApis] };
}

// The careers API lists positions with their Comeet-hosted page, whose path
// is the public board URL the comeet provider reads.
export async function comeetBoardFromApi(apiUrl, fetchJson) {
  const positions = await fetchJson(apiUrl);
  if (!Array.isArray(positions)) return null;
  for (const position of positions) {
    const match = String(position?.url_comeet_hosted_page || '').match(/^https:\/\/www\.comeet\.com\/jobs\/([a-z0-9-]+)\/([a-z0-9]{2}\.[a-z0-9]{3})\//i);
    if (match) return `https://www.comeet.com/jobs/${match[1]}/${match[2]}`;
  }
  return null;
}

// A repeated same-site link shape that looks like a job list: at least three
// links sharing a parent path, in a careers-like section or with role-like
// link texts, and not in a known non-job section.
export function inferJobLinkPattern(links, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return null; }
  const groups = new Map();
  for (const link of links) {
    let url;
    try { url = new URL(link.href); } catch { continue; }
    if (url.origin !== origin) continue;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const roleLike = ROLE_TEXT.test(link.text) || ROLE_TEXT.test(segments.at(-1).replace(/[-_]/g, ' '));
    // Every shared prefix depth: a job link can sit under its own id folder
    // (/careers-open-positions/co/<city>/<id>/<slug>), so the common part is
    // shorter than the parent path.
    for (let depth = 1; depth < segments.length; depth += 1) {
      const prefix = `/${segments.slice(0, depth).join('/')}/`;
      if (NON_JOB_SECTIONS.test(prefix)) break;
      const key = `${prefix}|${segments.length}`;
      const group = groups.get(key) || { prefix, depth, segments: segments.length, paths: new Set(), roleTexts: 0 };
      if (!group.paths.has(url.pathname)) {
        group.paths.add(url.pathname);
        if (roleLike) group.roleTexts += 1;
      }
      groups.set(key, group);
    }
  }
  let best = null;
  for (const group of groups.values()) {
    const count = group.paths.size;
    if (count < MIN_PATTERN_LINKS) continue;
    // Outside a careers-like section, most links must read like job titles
    // (a leadership or investor page also has a few "Director" links).
    const careersLike = JOB_SECTION.test(group.prefix);
    if (!careersLike && (group.roleTexts < 3 || group.roleTexts < count * 0.6)) continue;
    // The deepest prefix wins among equally large groups, so the pattern
    // stays as specific as the links allow.
    const score = count + (careersLike ? 10 : 0) + group.roleTexts * 2 + group.depth * 0.1;
    if (!best || score > best.score) best = { ...group, score };
  }
  return best ? { jobPathPrefix: best.prefix, jobPathSegments: best.segments, count: best.paths.size } : null;
}

export function openPositionsLinks(links, pageUrl) {
  const current = String(pageUrl).replace(/\/$/, '');
  const found = [];
  for (const link of links) {
    const href = String(link.href || '').split('#')[0];
    if (!href.startsWith('https://') || href.replace(/\/$/, '') === current || found.includes(href)) continue;
    if (OPEN_POSITIONS_LINK.test(link.text) || OPEN_POSITIONS_LINK.test(href)) found.push(href);
    if (found.length >= 2) break;
  }
  return found;
}

// The careers pages worth visiting: the company's own sites from its stored
// sources and research evidence, never job boards or known ATS boards.
export function careersPagesOf(company) {
  const pages = [];
  for (const source of company.sources || []) {
    const values = [source.provider === 'unsupported' ? source.careersUrl : null, ...(source.discoveryEvidence || [])];
    for (const value of values) {
      if (!value || isJobBoardUrl(value) || detectCompanyJobSource(safeUrl(value))) continue;
      if (!pages.includes(value)) pages.push(value);
    }
  }
  return pages.slice(0, MAX_PAGES);
}

function safeUrl(value) {
  try { return new URL(value).href; } catch { return 'https://invalid.invalid/'; }
}

function hasResearch(company) {
  return (company.sources || []).some((source) => (source.discoveryEvidence || []).length > 0);
}

/**
 * Resolves one candidate. Returns
 *   { status: 'watched', source, probe, how } or
 *   { status: 'unscannable', reason, detail }.
 * Persistence is the caller's job, so this can run as a dry run.
 */
export async function resolveCandidate(company, {
  research,
  discoverPage,
  probe = probeCompanySource,
  fetchJson,
  saveResearch = async () => {},
  log = () => {},
}) {
  const findings = { mismatch: null, platform: null, aggregator: false, failedBoard: null };
  const tryWatch = async (rawSource, how, { discoveredOn = null, aggregator = false } = {}) => {
    let source;
    try { source = normalizeCompanySource(rawSource); } catch { return null; }
    let result = await probe(source, company.name);
    // A rendered page occasionally fails on its first load; one retry.
    if (result.status === 'failed' && source.config?.renderWithBrowser) result = await probe(source, company.name);
    log(`    ${how}: ${source.provider} ${source.careersUrl} -> ${result.status} (${result.count})`);
    if (!VERIFIED.has(result.status)) {
      if (source.provider !== 'official-html') findings.failedBoard ||= source.careersUrl;
      return null;
    }
    if (source.provider === 'official-html' && result.status !== 'verified_jobs') return null;
    if (!sourceBelongsToCompany({ source, companyName: company.name, discoveredOn, aggregator })) {
      findings.mismatch ||= { source, probe: result };
      return null;
    }
    return { status: 'watched', source, probe: result, how };
  };

  // 1. Research a candidate that was never researched (e.g. one added from an
  //    "interested" LinkedIn job, which only carries the job's own URL).
  let current = company;
  if (!hasResearch(company) && research) {
    try {
      const result = await research(company.name);
      current = (await saveResearch(company, result)) || company;
      const src = result.candidate?.source;
      if (src && src.provider !== 'unsupported' && VERIFIED.has(result.probe?.status)) {
        const watched = await tryWatch(src, 'research');
        if (watched) return watched;
      }
    } catch (error) {
      log(`    research failed: ${error.message}`);
    }
  }

  // Sources already found but never verified as belonging (e.g. an earlier
  // import) get the same identity check before anything else.
  for (const source of current.sources || []) {
    if (source.provider === 'unsupported' || source.provider === 'official-html') continue;
    const watched = await tryWatch(source, 'known source');
    if (watched) return watched;
  }

  const pages = careersPagesOf(current);
  if (!pages.length) {
    const onlyBoards = (current.sources || []).every((source) => isJobBoardUrl(source.careersUrl));
    return onlyBoards
      ? { status: 'unscannable', reason: 'job_boards_only', detail: (current.sources || [])[0]?.careersUrl || null }
      : { status: 'unscannable', reason: 'no_careers_site', detail: null };
  }

  // 2. Visit each careers page; 3. one hop to an "open positions" page.
  const queue = pages.map((url) => ({ url, hop: 0 }));
  const visited = new Set();
  while (queue.length) {
    const { url, hop } = queue.shift();
    if (visited.has(url) || visited.size >= MAX_PAGES + 2) continue;
    visited.add(url);
    let page;
    try {
      page = await discoverPage(url);
    } catch (error) {
      log(`    could not render ${url}: ${error.message}`);
      continue;
    }
    findings.platform ||= unsupportedPlatformIn([page.url, ...page.requests, ...page.links.map((link) => link.href)]);

    // Links built by scripts are in page.links even when absent from the HTML.
    const linked = extractSupportedSourceCandidates(`${page.html}\n${page.links.map((link) => link.href).join('\n')}`, page.url);
    const background = boardUrlsFromRequests(page.requests);
    const boards = [...new Set([...linked, ...background.boards])];
    const aggregator = boards.length >= AGGREGATOR_BOARDS;
    findings.aggregator ||= aggregator;
    for (const apiUrl of background.comeetApis) {
      try {
        const board = await comeetBoardFromApi(apiUrl, fetchJson);
        if (board && !boards.includes(board)) boards.unshift(board);
      } catch { /* an unreadable API response is the same as no board */ }
    }
    for (const board of boards.slice(0, 5)) {
      const detected = detectCompanyJobSource(board);
      if (!detected) continue;
      const watched = await tryWatch(detected, 'board on careers page', { discoveredOn: page.url, aggregator });
      if (watched) return watched;
    }

    const pattern = inferJobLinkPattern(page.links, page.url);
    if (pattern) {
      for (const renderWithBrowser of [false, true]) {
        const watched = await tryWatch({
          provider: 'official-html',
          careersUrl: page.url,
          config: { jobPathPrefix: pattern.jobPathPrefix, jobPathSegments: pattern.jobPathSegments, renderWithBrowser },
        }, `job links ${pattern.jobPathPrefix} (${pattern.count})${renderWithBrowser ? ' rendered' : ''}`, { discoveredOn: page.url });
        if (watched) return watched;
      }
    }
    if (hop === 0) for (const next of openPositionsLinks(page.links, page.url)) queue.push({ url: next, hop: 1 });
  }

  // The board is kept (not watched) so one click on the companies page can
  // approve it when it really is the company's own.
  if (findings.mismatch) {
    return { status: 'unscannable', reason: 'board_name_mismatch', detail: findings.mismatch.source.careersUrl, ...findings.mismatch };
  }
  if (findings.platform) return { status: 'unscannable', reason: 'unsupported_platform', detail: findings.platform };
  if (findings.aggregator) return { status: 'unscannable', reason: 'aggregator_page', detail: pages[0] };
  if (findings.failedBoard) return { status: 'unscannable', reason: 'board_unavailable', detail: findings.failedBoard };
  return { status: 'unscannable', reason: 'no_jobs_found', detail: pages[0] };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const companyIndex = argv.indexOf('--company');
  const onlyCompany = companyIndex >= 0 ? identity(argv[companyIndex + 1]) : null;
  const { loadJobsConfig } = await import('./config.mjs');
  const { createJobStore } = await import('./store.mjs');
  const { createCompanyResearcher } = await import('./company-research.mjs');
  const { createCareersPageDiscovery } = await import('./company-page-discovery.mjs');
  const { makeHttpCtx } = await import('../providers/_http.mjs');
  const config = loadJobsConfig();
  const now = Date.now();
  const withStore = (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try { return callback(store); } finally { store.close(); }
  };

  const due = withStore((store) => store.listCompaniesDueForAutoResolve({ now, includeAll: Boolean(onlyCompany) }))
    .filter((company) => !onlyCompany || identity(company.name) === onlyCompany);
  console.log(`${due.length} חברות ממתינות לבדיקה אוטומטית${dryRun ? ' (הרצת ניסיון, בלי שמירה)' : ''}.`);
  if (!due.length) return;

  const research = createCompanyResearcher(config);
  const discovery = createCareersPageDiscovery();
  const http = makeHttpCtx();
  const summary = { watched: [], unscannable: [] };
  try {
    for (const company of due) {
      console.log(`• ${company.name}`);
      const outcome = await resolveCandidate(company, {
        research: dryRun ? null : research,
        discoverPage: (url) => discovery.discover(url),
        fetchJson: (url) => http.fetchJson(url, { timeoutMs: 15_000 }),
        log: (line) => console.log(line),
        saveResearch: async (target, result) => withStore((store) => {
          const saved = store.upsertCompanyCandidate(result.candidate);
          const source = saved.sources.find((item) => item.provider === result.candidate.source?.provider &&
            item.careersUrl === result.candidate.source?.careersUrl);
          if (source && result.probe) store.recordCompanySourceProbe(source.id, result.probe, result.research?.evidenceUrls || []);
          return store.getCompany(target.id);
        }),
      });
      if (outcome.status === 'watched') {
        summary.watched.push(`${company.name} (${outcome.source.provider}, ${outcome.probe.count} משרות; ${outcome.how})`);
        if (!dryRun) withStore((store) => {
          const saved = store.upsertCompanySource(company.id, { ...outcome.source, enabled: true });
          store.recordCompanySourceProbe(saved.id, outcome.probe, []);
          store.approveCompany(company.id);
          store.recordAutoResolve(company.id, { status: 'auto_watched', reason: null, detail: `${outcome.source.provider}: ${outcome.source.careersUrl}`, at: now });
        });
      } else {
        summary.unscannable.push(`${company.name}: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`);
        if (!dryRun) withStore((store) => {
          if (outcome.source) {
            const saved = store.upsertCompanySource(company.id, { ...outcome.source, enabled: true });
            store.recordCompanySourceProbe(saved.id, outcome.probe, []);
          }
          store.recordAutoResolve(company.id, {
            status: 'unscannable', reason: outcome.reason, detail: outcome.detail, at: now, nextAt: now + RETRY_DAYS * DAY_MS,
          });
        });
      }
    }
  } finally {
    await discovery.close();
  }
  console.log(`\nנוספו למעקב אוטומטית (${summary.watched.length}):\n${summary.watched.map((line) => `  ${line}`).join('\n')}`);
  console.log(`\nלא ניתן לסרוק (${summary.unscannable.length}):\n${summary.unscannable.map((line) => `  ${line}`).join('\n')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
