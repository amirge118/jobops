// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Generic fallback for career pages that render their own job list from data
// already embedded in the page (Next.js `__NEXT_DATA__`, Nuxt's `__NUXT__`,
// a generic `__INITIAL_STATE__`/`__PRELOADED_STATE__` blob, or a plain
// `<script type="application/json">` payload) instead of linking out to a
// known ATS. No per-company configuration is required — the page is sniffed
// for an array of job-shaped objects at fetch time. Because the shape is
// content-based rather than a known URL pattern, this provider is never
// auto-detected from a bare URL (see `detect` below); the discovery pipeline
// opts a company into it explicitly after a page has already been fetched
// and inspected.

const MAX_HTML_BYTES = 3_000_000;
const MAX_JSON_BLOBS = 20;
const MAX_BLOB_BYTES = 2_000_000;
const MAX_WALK_NODES = 20_000;
const MAX_WALK_DEPTH = 8;
const MAX_JOBS = 500;
const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 200;

const TITLE_KEYS = /^(title|name|position|positionname|position_name|role|jobtitle|job_title)$/i;
const URL_KEYS = /^(url|link|href|slug|permalink|applyurl|apply_url|detailpagelink|detail_page_link|path)$/i;
const LOCATION_KEYS = /^(location|city|locationname|location_name|comeet_location_names)$/i;
const JOB_KEY_HINT = /job|position|career|opening|vacan|role/i;

function findBalancedJson(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull out every plausible JSON object/array literal embedded in the page. */
export function extractJsonCandidates(html) {
  const markup = String(html || '');
  const candidates = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of markup.matchAll(scriptPattern)) {
    if (candidates.length >= MAX_JSON_BLOBS) break;
    const attrs = match[1] || '';
    const body = match[2] || '';
    if (Buffer.byteLength(body, 'utf8') > MAX_BLOB_BYTES) continue;
    const isJsonType = /type\s*=\s*["']application\/(json|ld\+json)["']/i.test(attrs);
    if (isJsonType) {
      const trimmed = body.trim();
      if (trimmed) candidates.push(trimmed);
      continue;
    }
    // Inline bootstrap assignments: window.__NEXT_DATA__ = {...}; / var __NUXT__ = {...};
    for (const assign of body.matchAll(/(?:window\.)?(?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|__PRELOADED_STATE__)\s*=\s*([{[])/g)) {
      const start = (assign.index ?? 0) + assign[0].length - 1;
      const json = findBalancedJson(body, start);
      if (json) candidates.push(json);
      if (candidates.length >= MAX_JSON_BLOBS) break;
    }
  }
  return candidates;
}

function jobSignals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { hasTitle: false, hasLink: false, hasLocation: false };
  let hasTitle = false;
  let hasLink = false;
  let hasLocation = false;
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') continue;
    if (!hasTitle && TITLE_KEYS.test(key) && val.trim().length >= MIN_TITLE_LENGTH && val.length <= MAX_TITLE_LENGTH) hasTitle = true;
    if (!hasLink && URL_KEYS.test(key) && val.trim()) hasLink = true;
    if (!hasLocation && LOCATION_KEYS.test(key) && val.trim()) hasLocation = true;
  }
  return { hasTitle, hasLink, hasLocation };
}

// A generic "title" + "url" pair is common in menus, related-content lists,
// and marketing cards — not just job postings. Only trust that pair alone
// when the enclosing property name itself says "jobs"/"positions"/etc.;
// otherwise also require a location-shaped field, which unrelated content
// arrays essentially never carry.
function isJobShapedObject(value, keyHinted) {
  const { hasTitle, hasLink, hasLocation } = jobSignals(value);
  return keyHinted ? hasTitle && hasLink : hasTitle && hasLink && hasLocation;
}

function fieldMatching(value, pattern) {
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && val.trim() && pattern.test(key)) return val.trim();
  }
  return '';
}

function toAbsoluteJobUrl(rawValue, baseUrl) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  try {
    const absolute = new URL(value, baseUrl);
    if (absolute.protocol !== 'https:' || absolute.origin !== new URL(baseUrl).origin) return '';
    return absolute.toString();
  } catch {
    return '';
  }
}

/**
 * Recursively find arrays of job-shaped objects anywhere in a parsed JSON
 * tree. A key name hint (e.g. "jobs", "positions", "openings") is enough on
 * its own once at least one item in the array looks job-shaped; otherwise
 * every item in the array must look job-shaped to avoid picking up an
 * unrelated list that merely happens to have a "title" and "url" field.
 */
function findJobArrays(node, parentKey, depth, budget, results) {
  if (depth > MAX_WALK_DEPTH || budget.nodes <= 0 || !node || typeof node !== 'object') return;
  budget.nodes -= 1;
  if (Array.isArray(node)) {
    if (node.length > 0 && node.length <= MAX_JOBS * 2) {
      const objectItems = node.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (objectItems.length === node.length) {
        const keyHinted = JOB_KEY_HINT.test(String(parentKey || ''));
        const shaped = objectItems.filter((item) => isJobShapedObject(item, keyHinted));
        if (shaped.length === objectItems.length) results.push(shaped);
      }
    }
    for (const item of node) findJobArrays(item, parentKey, depth + 1, budget, results);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    findJobArrays(value, key, depth + 1, budget, results);
  }
}

export function extractEmbeddedJsonJobs(html, baseUrl, companyName) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`embedded-json: HTML exceeds ${MAX_HTML_BYTES} bytes`);
  }
  const jobArrays = [];
  const budget = { nodes: MAX_WALK_NODES };
  for (const candidate of extractJsonCandidates(html)) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    findJobArrays(parsed, '', 0, budget, jobArrays);
    if (budget.nodes <= 0) break;
  }
  // Prefer the largest matching array — the real listing, not a "related" sidebar.
  jobArrays.sort((left, right) => right.length - left.length);
  const jobs = [];
  const seen = new Set();
  for (const item of jobArrays[0] || []) {
    const title = fieldMatching(item, TITLE_KEYS).slice(0, MAX_TITLE_LENGTH);
    const url = toAbsoluteJobUrl(fieldMatching(item, URL_KEYS), baseUrl);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    jobs.push({ title, url, company: String(companyName || '').trim(), location: fieldMatching(item, LOCATION_KEYS) });
    if (jobs.length >= MAX_JOBS) break;
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'embedded-json',

  // Deliberately never auto-detected from a bare careers URL: any page could
  // contain *some* JSON with title/url-shaped fields, so treating that as a
  // positive match during a blind scan would create false positives across
  // unrelated companies. The discovery pipeline (company-source-resolver.mjs)
  // only opts a company into this provider after fetching its careers page
  // and confirming a job-shaped array is actually present.
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx.fetchLimitedText !== 'function') {
      throw new Error('embedded-json: bounded HTML transport is unavailable');
    }
    const html = await ctx.fetchLimitedText(entry.careers_url, {
      redirect: 'follow', timeoutMs: 15_000, maxBytes: MAX_HTML_BYTES,
    });
    const jobs = extractEmbeddedJsonJobs(html, entry.careers_url, entry.name);
    if (jobs.length === 0) {
      throw new Error('embedded-json: no job-shaped data found in the page');
    }
    return jobs;
  },
};
