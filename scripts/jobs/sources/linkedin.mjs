// LinkedIn public (guest, no login) job search.
//
// Endpoint, card markup and pacing were learned from JobSpy (MIT) and
// hendrixfreire/linkedin-job-scraper (MIT); see THIRD_PARTY_NOTICES.md. This
// is an independent Node implementation: it never logs in, never stores a
// LinkedIn session, and stops on any block instead of working around it.

import { linkedinWindowSettings, nextCoveredUntil, planLinkedInWindow } from '../linkedin-window.mjs';

export const LINKEDIN_SEARCH_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
export const LINKEDIN_POSTING_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
export const LINKEDIN_HEADERS = Object.freeze({
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
});

// The guest endpoint refuses to page past ~1000 results.
const MAX_START = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_TOLERANCE_MS = 60 * 60 * 1000;

export const DEFAULT_LINKEDIN_LIMITS = Object.freeze({
  maxPagesPerSearch: 6,
  maxRequestsPerRun: 40,
  maxDetailFetchesPerRun: 40,
  delayMs: [3_000, 7_000],
  runTimeoutMs: 300_000,
});

export function buildSearchUrl({ keywords, location, geoId, tprSeconds, start = 0 }) {
  const url = new URL(LINKEDIN_SEARCH_ENDPOINT);
  if (keywords) url.searchParams.set('keywords', keywords);
  if (location) url.searchParams.set('location', location);
  if (geoId) url.searchParams.set('geoId', String(geoId));
  if (Number.isFinite(tprSeconds) && tprSeconds > 0) {
    url.searchParams.set('f_TPR', `r${Math.ceil(tprSeconds)}`);
  }
  url.searchParams.set('sortBy', 'DD');
  url.searchParams.set('start', String(Math.max(0, Math.floor(start))));
  return url.toString();
}

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;|&#160;/gi, ' ');
}

function cleanText(html) {
  return decodeEntities(String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, pattern) {
  return html.match(pattern)?.[1] ?? '';
}

export function linkedinViewUrl(linkedinId) {
  return `https://www.linkedin.com/jobs/view/${linkedinId}`;
}

const AGE_UNITS_MS = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };

// Cards say "3 hours ago" / "1 day ago" (the datetime attribute is only a
// date). The label is truncated, so N units is a *lower bound* on the age:
// "5 hours ago" means at least 5h. null when the label is missing or unknown.
export function postedAgeLowerBoundMs(label) {
  const text = String(label ?? '').toLowerCase().trim();
  if (!text) return null;
  if (/^just now|^moments? ago/.test(text)) return 0;
  const match = text.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago/);
  return match ? Number(match[1]) * AGE_UNITS_MS[match[2]] : null;
}

// Required title words for one search. A title passes when it contains any
// term as a whole word (so "java" never matches "javascript"). Titles are
// normalized first: case, hyphens/slashes, and Hebrew gendered suffixes such
// as "מנתח-ת". An empty list accepts every title.
function normalizeTitle(value) {
  return ` ${String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[-/]ת(?=[\s,)]|$)/g, '')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

export function buildTitleIncludeFilter(terms = []) {
  const needles = (Array.isArray(terms) ? terms : []).map((term) => normalizeTitle(term).trim()).filter(Boolean);
  if (!needles.length) return () => true;
  return (title) => {
    const normalized = normalizeTitle(title);
    return needles.some((needle) => normalized.includes(` ${needle} `));
  };
}

// One search page is a list of <li> fragments, each holding one
// `base-search-card` div. Parsing is regex-based on purpose — jobOps has no
// HTML-parser dependency, and a missed selector surfaces as a
// `structure_changed` classification rather than a silent zero.
export function parseSearchPage(html) {
  const source = String(html ?? '');
  const chunks = source.split(/<li\b[^>]*>/i).slice(1);
  const cards = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const linkedinId = firstMatch(chunk, /data-entity-urn="urn:li:jobPosting:(\d+)"/) ||
      firstMatch(chunk, /\/jobs\/view\/(?:[^"?]*-)?(\d{6,})(?:[/?"]|$)/);
    if (!linkedinId || seen.has(linkedinId)) continue;
    seen.add(linkedinId);
    const title = cleanText(firstMatch(chunk, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i)) ||
      cleanText(firstMatch(chunk, /<span class="sr-only">([\s\S]*?)<\/span>/i));
    const company = cleanText(firstMatch(chunk, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i));
    const location = cleanText(firstMatch(chunk, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/i));
    const listedAt = firstMatch(chunk, /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i) || null;
    const postedLabel = cleanText(firstMatch(chunk, /<time[^>]*>([\s\S]*?)<\/time>/i)) || null;
    cards.push({
      linkedinId, title, company, location, listedAt, postedLabel,
      postedAgeMs: postedAgeLowerBoundMs(postedLabel), url: linkedinViewUrl(linkedinId),
    });
  }
  return { cards, listItems: chunks.length };
}

// LinkedIn never answers an unmatched query with an empty page: it silently
// substitutes unrelated "popular" jobs (verified 2026-09-28 — a nonsense
// query returned 10 cards such as "Offshore Chemist"). A page is therefore
// only trusted when enough of its titles share a term with the query;
// otherwise it is treated as "no real matches", never scored.
const QUERY_STOPWORDS = new Set(['or', 'and', 'not', 'the', 'end', 'side', 'with', 'for']);
const MIN_RELEVANT_SHARE = 0.3;

export function searchTerms(keywords) {
  return [...new Set(String(keywords ?? '')
    .toLowerCase()
    .replace(/["()]/g, ' ')
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((term) => term.replace(/^\.+|\.+$/g, ''))
    .filter((term) => term.length >= 3 && !QUERY_STOPWORDS.has(term)))];
}

export function isFallbackPage(cards, keywords) {
  const terms = searchTerms(keywords);
  if (!terms.length || !cards.length) return false;
  const relevant = cards.filter((card) => {
    const title = String(card.title || '').toLowerCase();
    return terms.some((term) => title.includes(term));
  }).length;
  return relevant / cards.length < MIN_RELEVANT_SHARE;
}

const BLOCK_URL = /linkedin\.com\/(?:authwall|signup|login|checkpoint|uas\/login)/i;

// Every failure mode stays distinguishable from "no jobs": an empty result
// is only `empty` when the body is genuinely empty (the guest API returns an
// empty 200 once results run out), never when markup was present but no card
// could be read.
export function classifySearchResponse({ status, finalUrl = '', html = '', cards = [], error = null }) {
  if (error) {
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout|aborted/i.test(error.message || '');
    return timedOut
      ? { status: 'timeout', reason: 'LinkedIn did not answer in time.' }
      : { status: 'network_error', reason: 'LinkedIn could not be reached.' };
  }
  if (status === 429) return { status: 'rate_limited', reason: 'LinkedIn rate limit (HTTP 429).' };
  if (status === 999 || BLOCK_URL.test(finalUrl)) {
    return { status: 'blocked', reason: `LinkedIn requires sign-in or blocked the request (HTTP ${status}).` };
  }
  if (status >= 500) return { status: 'network_error', reason: `LinkedIn server error (HTTP ${status}).` };
  if (status === 400 && !String(html).trim()) {
    // The guest endpoint answers 400 once `start` passes the last result.
    return { status: 'empty', reason: 'No more results.' };
  }
  if (status < 200 || status >= 300) return { status: 'http_error', reason: `Unexpected HTTP ${status} from LinkedIn.` };
  if (cards.length > 0) return { status: 'ok', reason: null };
  const text = cleanText(html);
  if (!text) return { status: 'empty', reason: 'No results in this window.' };
  if (/sign in|join now|authwall|security verification|captcha/i.test(text)) {
    return { status: 'blocked', reason: 'LinkedIn returned a sign-in or verification page.' };
  }
  return { status: 'structure_changed', reason: 'LinkedIn returned content, but no job card could be read.' };
}

export async function fetchWithTimeout(fetchImpl, url, { timeoutMs = REQUEST_TIMEOUT_MS, headers = LINKEDIN_HEADERS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers });
    const html = await response.text();
    return { status: response.status, finalUrl: response.url || url, html };
  } finally {
    clearTimeout(timer);
  }
}

function randomDelay([min, max]) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A run-wide budget shared by every search, so N searches cannot multiply
// the request volume, and one block halts all of them.
export function createLinkedInBudget(limits = {}, { now = Date.now } = {}) {
  const merged = { ...DEFAULT_LINKEDIN_LIMITS, ...limits };
  const startedAt = now();
  return {
    limits: merged,
    requests: 0,
    detailFetches: 0,
    haltedBy: null,
    hasRequests() { return this.requests < merged.maxRequestsPerRun; },
    timedOut() { return now() - startedAt > merged.runTimeoutMs; },
  };
}

// Pages through one search, sorted newest first, within [from, to].
// Termination: an empty page, a page with no unseen ids (loop guard), the
// 1000-result ceiling, the per-search page cap, or the shared run budget.
// A page whose cards are all known or later filtered still counts as
// progress; filtering happens in the caller, after collection.
export async function runLinkedInSearch({
  search,
  window,
  budget,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  isFirstRequest = () => budget.requests === 0,
}) {
  const tprSeconds = Math.max(60, Math.ceil((window.to - window.from) / 1000));
  // Local check of LinkedIn's own time filter: a card whose minimum age is
  // beyond the window (plus one label unit of slack) is dropped, and a page
  // made only of such cards ends pagination.
  const maxAgeMs = window.to - window.from + STALE_TOLERANCE_MS;
  let stale = 0;
  const cards = [];
  const ids = new Set();
  let start = 0;
  let pages = 0;
  let capped = false;
  let status = 'complete';
  let reason = null;
  let endedBy = 'end_of_results';

  while (true) {
    if (budget.haltedBy) { status = pages ? 'partial' : 'failed'; reason = budget.haltedBy; endedBy = 'halted'; break; }
    if (pages >= budget.limits.maxPagesPerSearch) { capped = true; status = 'partial'; endedBy = 'page_limit'; break; }
    if (!budget.hasRequests()) { capped = true; status = pages ? 'partial' : 'failed'; endedBy = 'request_limit'; reason = 'request_limit'; break; }
    if (budget.timedOut()) { capped = true; status = pages ? 'partial' : 'failed'; endedBy = 'time_limit'; reason = 'time_limit'; break; }
    if (start >= MAX_START) { capped = true; status = 'partial'; endedBy = 'result_ceiling'; break; }

    if (!isFirstRequest()) await sleep(randomDelay(budget.limits.delayMs));
    const url = buildSearchUrl({ keywords: search.keywords, location: search.location, geoId: search.geoId, tprSeconds, start });
    let response;
    let classification;
    budget.requests += 1;
    try {
      response = await fetchWithTimeout(fetchImpl, url);
    } catch (error) {
      classification = classifySearchResponse({ error });
    }
    const parsed = response ? parseSearchPage(response.html) : { cards: [] };
    classification ||= classifySearchResponse({ ...response, cards: parsed.cards });

    if (classification.status === 'empty') { endedBy = pages === 0 ? 'empty_first_page' : 'end_of_results'; break; }
    if (classification.status !== 'ok') {
      status = pages ? 'partial' : 'failed';
      reason = classification.status;
      endedBy = classification.status;
      if (['blocked', 'rate_limited'].includes(classification.status)) budget.haltedBy = classification.status;
      break;
    }

    if (isFallbackPage(parsed.cards, search.keywords)) {
      endedBy = pages === 0 ? 'no_matches_fallback' : 'fallback_after_results';
      break;
    }
    pages += 1;
    const fresh = parsed.cards.filter((card) => !ids.has(card.linkedinId));
    if (fresh.length === 0) { endedBy = 'repeated_page'; break; }
    const inWindow = fresh.filter((card) => card.postedAgeMs == null || card.postedAgeMs <= maxAgeMs);
    stale += fresh.length - inWindow.length;
    for (const card of fresh) ids.add(card.linkedinId);
    cards.push(...inWindow);
    if (inWindow.length === 0) { endedBy = 'older_than_window'; break; }
    start += parsed.cards.length;
  }

  return { status, reason, capped, endedBy, pages, cards, stale, tprSeconds };
}

// Guest job-posting page. The offsite apply URL is only exposed on some
// pages (inside <code id="applyUrl">); the guest endpoint usually hides it
// behind a sign-in modal, in which case the LinkedIn page stays the link.
export function parsePostingPage(html) {
  const source = String(html ?? '');
  const descriptionHtml = firstMatch(source, /<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i);
  const description = cleanText(descriptionHtml.replace(/<(?:br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n'));
  const title = cleanText(firstMatch(source, /<h[12][^>]*topcard__title[^>]*>([\s\S]*?)<\/h[12]>/i));
  const company = cleanText(firstMatch(source, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i));
  const location = cleanText(firstMatch(source, /<span[^>]*topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/i));
  const criteria = {};
  for (const match of source.matchAll(/<h3[^>]*description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi)) {
    criteria[cleanText(match[1])] = cleanText(match[2]);
  }
  const applyCode = firstMatch(source, /<code[^>]*id="applyUrl"[^>]*>([\s\S]*?)<\/code>/i);
  let applyUrl = null;
  const encoded = applyCode.match(/[?&]url=([^"&]+)/)?.[1];
  if (encoded) {
    try {
      const decoded = decodeURIComponent(decodeEntities(encoded));
      if (/^https?:\/\//i.test(decoded)) applyUrl = decoded;
    } catch { /* malformed — keep the LinkedIn page as the link */ }
  }
  const closed = /no longer accepting applications/i.test(cleanText(source));
  return { title, company, location, description, criteria, applyUrl, closed };
}

// ---- Collection: searches -> sightings -> progress ------------------------

export const DEFAULT_LINKEDIN_AREAS = Object.freeze(['Tel Aviv District', 'Center District']);

// Cards carry LinkedIn's own "City, District, Country" string. The target
// is Tel Aviv and the center; a bare "Israel" (no district) is kept too,
// because it is ambiguous rather than out of area.
export function buildLinkedInAreaFilter(areas = DEFAULT_LINKEDIN_AREAS) {
  const needles = areas.map((area) => String(area).toLowerCase()).filter(Boolean);
  return (location) => {
    const value = String(location || '').trim().toLowerCase();
    if (!value || value === 'israel') return true;
    return needles.some((needle) => value.includes(needle));
  };
}

export async function scanLinkedIn({
  config,
  store,
  mode = 'auto',
  manualHours = null,
  passesTitle = () => true,
  fetchImpl = globalThis.fetch,
  sleep,
  now = Date.now(),
}) {
  const windowSettings = linkedinWindowSettings(config);
  const linkedin = config.sources?.linkedin || {};
  const budget = createLinkedInBudget(linkedin.limits || {});
  const passesArea = buildLinkedInAreaFilter(linkedin.acceptedAreas || DEFAULT_LINKEDIN_AREAS);
  const searches = store.listLinkedInSearches().filter((search) => search.enabled);
  // Title scope lives only in config (it filters results, it is not part of
  // what LinkedIn is asked, so it does not change a search's query hash). A
  // title is in scope when it matches ANY search's terms: an analyst role
  // surfaced by the data-engineering query is still a wanted role.
  const configured = (linkedin.searches || []).filter((search) => search.enabled !== false);
  const scopeTerms = configured.flatMap((search) => search.titleIncludes || []);
  const inScope = configured.some((search) => !(search.titleIncludes || []).length)
    ? () => true
    : buildTitleIncludeFilter(scopeTerms);
  const candidates = [];
  const results = [];

  for (const search of searches) {
    const plan = planLinkedInWindow({ coveredUntil: search.coveredUntil, mode, manualHours, settings: windowSettings, now });
    const outcome = await runLinkedInSearch({ search, window: plan, budget, fetchImpl, ...(sleep ? { sleep } : {}) });
    const counts = { found: outcome.cards.length, new: 0, known: 0, filtered: 0, stale: outcome.stale || 0 };
    const source = `LinkedIn: ${search.label}`;
    for (const card of outcome.cards) {
      const sighting = store.recordSighting({
        url: card.url, company: card.company, title: card.title, source, seenAt: now,
      });
      store.recordLinkedInPosting({ linkedinId: card.linkedinId, jobKey: sighting.jobKey, listedAt: card.listedAt, seenAt: now });
      counts[sighting.isNew ? 'new' : 'known'] += 1;
      if (!sighting.isNew) continue;
      const filterReason = !inScope(card.title) ? 'scope' : !passesTitle(card.title) ? 'title'
        : !passesArea(card.location) ? 'location'
          : store.isCompanyBlocked?.(card.company) ? 'company' : null;
      if (filterReason) {
        counts.filtered += 1;
        store.saveEvaluation(sighting.jobKey, {
          company: card.company, title: card.title,
          summary: null, score: 1, fitLabel: 'לא מתאים',
          decisionReason: {
            scope: 'סונן: הכותרת אינה כוללת אף מילת תפקיד שהוגדרה לחיפוש (titleIncludes).',
            title: 'סונן לפי מילת מפתח שלילית בכותרת.',
            location: 'סונן לפי אזור (מחוץ לתל אביב והמרכז).',
            company: 'סונן: החברה סומנה כ"חברה לא מעניינת" בעמוד ההחלטות.',
          }[filterReason],
          suitable: false, applyUrl: card.url, activeStatus: 'unknown',
          contentHash: null, profileHash: null, criteriaVersion: config.decision?.criteriaVersion ?? null,
          evaluatedAt: now,
        });
        continue;
      }
      candidates.push({ ...sighting, url: sighting.canonicalUrl, company: card.company, title: card.title,
        location: card.location, postedAt: card.listedAt, source });
    }
    results.push({ search, plan, outcome, counts });
  }

  // An empty first page is only believable when LinkedIn demonstrably
  // answered other searches in this run; otherwise it may be a soft block.
  const endpointAnswered = results.some(({ outcome }) => outcome.pages > 0 || outcome.endedBy === 'no_matches_fallback');
  const rows = results.map(({ search, plan, outcome, counts }) => {
    let status = outcome.status;
    let reason = outcome.reason;
    if (status === 'complete' && outcome.endedBy === 'empty_first_page' && !endpointAnswered) {
      status = 'failed';
      reason = 'empty_unverified';
    }
    // A throttled LinkedIn serves generic "popular" jobs before it starts
    // answering 429 (seen live 2026-09-29 08:00). "No real matches" is
    // therefore not trusted in a run that was blocked or rate limited.
    if (status === 'complete' && outcome.endedBy === 'no_matches_fallback' && budget.haltedBy) {
      status = 'failed';
      reason = 'empty_unverified';
    }
    if (outcome.capped && !reason) reason = 'capped';
    const coveredUntil = nextCoveredUntil({ plan, status, previous: search.coveredUntil });
    const advanced = coveredUntil != null && coveredUntil !== search.coveredUntil;
    const row = {
      id: search.id, label: search.label, status, reason, endedBy: outcome.endedBy, capped: outcome.capped,
      pages: outcome.pages, window: { from: plan.from, to: plan.to, basis: plan.basis, mode: plan.mode },
      warning: plan.warning, gap: advanced ? plan.gap : null, advanced, ...counts,
    };
    store.recordLinkedInSearchAttempt({
      searchId: search.id, queryHash: search.queryHash, status, reason,
      summary: { ...row, id: undefined, label: undefined },
      coveredUntil: advanced ? coveredUntil : null, gap: row.gap, attemptedAt: now,
    });
    return row;
  });

  const errors = rows.filter((row) => row.status !== 'complete')
    .map((row) => ({ search: row.label, code: `linkedin_${row.reason || 'failed'}` }));
  return { source: 'linkedin', candidates, searches: rows, errors, haltedBy: budget.haltedBy, requests: budget.requests,
    discovery: { found: rows.reduce((n, r) => n + r.found, 0), new: rows.reduce((n, r) => n + r.new, 0), known: rows.reduce((n, r) => n + r.known, 0) } };
}
