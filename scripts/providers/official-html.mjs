// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { normalizeCompanyUrl } from '../jobs/company-registry.mjs';

const MAX_HTML_BYTES = 3_000_000;
const MAX_PATH_PREFIX_LENGTH = 200;
const MAX_PATH_SEGMENTS = 12;
const MAX_IGNORED_PATHS = 100;
const MAX_JOB_LINKS = 500;
const GENERIC_LINK_TEXT = new Set([
  'apply', 'apply now', 'view', 'view job', 'view position', 'learn more',
  'read more', 'details', 'more details', 'לפרטים', 'הגשת מועמדות',
]);

function publicHttpsUrl(value) {
  try {
    normalizeCompanyUrl(value, { keepQuery: true });
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe');
    parsed.hash = '';
    return parsed;
  } catch {
    throw new Error('official-html: careers URL must be a public HTTPS URL');
  }
}

function normalizePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || path.length > MAX_PATH_PREFIX_LENGTH || path.includes('?') || path.includes('#')) {
    throw new Error(`official-html: ${label} must be a bounded absolute path`);
  }
  return path.replace(/\/+/g, '/');
}

export function validateOfficialHtmlEntry(entry) {
  const listingUrl = publicHttpsUrl(entry?.careers_url);
  const jobPathPrefix = normalizePath(entry?.job_path_prefix, 'job path prefix');
  const jobPathSegments = Number(entry?.job_path_segments);
  if (!Number.isInteger(jobPathSegments) || jobPathSegments < 1 || jobPathSegments > MAX_PATH_SEGMENTS) {
    throw new Error(`official-html: job path segment count must be between 1 and ${MAX_PATH_SEGMENTS}`);
  }
  const rawIgnored = entry?.ignored_job_paths ?? [];
  if (!Array.isArray(rawIgnored) || rawIgnored.length > MAX_IGNORED_PATHS) {
    throw new Error(`official-html: ignored job paths must contain at most ${MAX_IGNORED_PATHS} entries`);
  }
  return {
    listingUrl,
    jobPathPrefix,
    jobPathSegments,
    ignoredJobPaths: new Set(rawIgnored.map((value) => normalizePath(value, 'ignored job path'))),
  };
}

function decodeHtml(value) {
  return String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function usefulTitle(value) {
  const title = decodeHtml(value);
  if (!title || !/[\p{L}\p{N}]/u.test(title) || GENERIC_LINK_TEXT.has(title.toLocaleLowerCase('en'))) return '';
  return title;
}

function compactLinkTitle(value) {
  const title = usefulTitle(value);
  if (!title || title.length > 160 || title.split(/\s+/).length > 20) return '';
  return title;
}

function titledElementWithin(value) {
  const markup = String(value);
  const hinted = markup.match(/<(?:h[1-6]|p|div|span)\b[^>]*class\s*=\s*["'][^"']*(?:position-name|position__title|job-title|role-title|posting-title|elementor-heading-title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:h[1-6]|p|div|span)>/i);
  if (hinted) return usefulTitle(hinted[1]);
  const heading = markup.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (heading) return usefulTitle(heading[1]);
  const paragraph = markup.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return paragraph ? usefulTitle(paragraph[1]) : '';
}

function nearestHeading(html, index) {
  const context = html.slice(Math.max(0, index - 2_000), index);
  let heading = '';
  for (const match of context.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    heading = usefulTitle(match[1]);
  }
  return heading;
}

function titleFromUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const ignored = /^(?:all|position|job|jobs|career|careers|co)$/i;
  const idOnly = /^(?:[a-f\d]{8}-[a-f\d-]{27,}|[a-f\d]{2}\.[a-f\d]{3}|jr\d+|\d+)$/i;
  const slug = [...parts].reverse().find((part) => !ignored.test(part) && !idOnly.test(part)) || '';
  let decodedSlug = slug;
  try {
    decodedSlug = decodeURIComponent(slug);
  } catch {
    // A malformed link on one external careers page must not abort the company scan.
  }
  return decodedSlug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(?:Ai|Bi|Qa|Vp|R&D)\b/g, (word) => word.toUpperCase())
    .trim()
    .slice(0, 200);
}

function normalizeJobLink(rawHref, listingUrl) {
  try {
    const absolute = new URL(rawHref.replaceAll('&amp;', '&'), listingUrl);
    if (absolute.origin !== listingUrl.origin || absolute.protocol !== 'https:') return null;
    absolute.hash = '';
    for (const key of [...absolute.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || ['ref', 'source', 'gh_src'].includes(key.toLowerCase())) {
        absolute.searchParams.delete(key);
      }
    }
    return absolute;
  } catch {
    return null;
  }
}

export function extractOfficialHtmlJobs(html, entry) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`official-html: HTML exceeds ${MAX_HTML_BYTES} bytes`);
  }
  const rule = validateOfficialHtmlEntry(entry);
  const jobs = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const url = normalizeJobLink(match[1] ?? match[2] ?? '', rule.listingUrl);
    if (!url || !url.pathname.startsWith(rule.jobPathPrefix)) continue;
    if (url.pathname.split('/').filter(Boolean).length !== rule.jobPathSegments) continue;
    if (rule.ignoredJobPaths.has(url.pathname) || seen.has(url.href)) continue;
    const title = titledElementWithin(match[3]) || compactLinkTitle(match[3]) || titleFromUrl(url) ||
      nearestHeading(html, match.index ?? 0) || usefulTitle(match[3]);
    if (!title) continue;
    seen.add(url.href);
    jobs.push({ title, url: url.href, company: String(entry.name || '').trim(), location: '' });
    if (jobs.length > MAX_JOB_LINKS) throw new Error(`official-html: more than ${MAX_JOB_LINKS} job links matched`);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'official-html',

  detect(entry) {
    try {
      return entry?.job_path_prefix ? { url: validateOfficialHtmlEntry(entry).listingUrl.href } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const rule = validateOfficialHtmlEntry(entry);
    const useBrowser = entry.render_with_browser === true || entry.renderWithBrowser === true;
    let html;
    if (useBrowser) {
      // Opt-in only, per company: a plain fetch sees nothing on a
      // JS-rendered careers page (React/Next.js SPA with no server-rendered
      // job list), and this project deliberately never launches a browser
      // automatically for a URL it hasn't been told needs one. Dynamic
      // import keeps every other scan free of Playwright's startup cost.
      const fetchPageWithBrowser = ctx.fetchPageWithBrowser
        || (await import('../jobs/browser-fetch.mjs')).fetchPageWithBrowser;
      const page = await fetchPageWithBrowser(rule.listingUrl.href, { timeoutMs: 25_000 });
      html = page.html;
    } else {
      if (typeof ctx.fetchLimitedText !== 'function') {
        throw new Error('official-html: bounded HTML transport is unavailable');
      }
      html = await ctx.fetchLimitedText(rule.listingUrl.href, {
        redirect: 'error', timeoutMs: 15_000, maxBytes: MAX_HTML_BYTES,
      });
    }
    const jobs = extractOfficialHtmlJobs(html, entry);
    if (jobs.length === 0 && entry.allow_empty !== true) {
      throw new Error('official-html: no matching job links found; verify the configured path rule');
    }
    return jobs;
  },
};
