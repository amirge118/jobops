// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const BOARD_HOST = /^([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com$/i;
const MAX_JOBS = 5_000;
const PAGE_SIZE = 20;
const MAX_PAGE_BYTES = 2_000_000;

export function parseWorkdayBoardUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.match(BOARD_HOST);
    const segments = url.pathname.split('/').filter(Boolean);
    const localeOffset = segments[0] && /^[a-z]{2}-[a-z]{2}$/i.test(segments[0]) ? 1 : 0;
    const site = segments[localeOffset];
    if (url.protocol !== 'https:' || !host || !site || site === 'wday') return null;
    return { url, tenant: host[1], site, publicBasePath: `/${segments.slice(0, localeOffset + 1).join('/')}` };
  } catch {
    return null;
  }
}

function safeExternalJobUrl(board, value) {
  const path = String(value || '');
  if (!path.startsWith('/job/') || path.includes('\\')) return '';
  const url = new URL(`${board.publicBasePath}${path}`, board.url.origin);
  return url.hostname === board.url.hostname && url.protocol === 'https:' ? url.href : '';
}

export function postedOnToIso(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (/^posted today$/i.test(text)) return new Date(now).toISOString();
  const match = text.match(/^posted\s+(\d+)\s+days?\s+ago$/i);
  return match ? new Date(now - Number(match[1]) * 86_400_000).toISOString() : '';
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const board = parseWorkdayBoardUrl(entry?.careers_url);
    return board ? { url: board.url.href } : null;
  },

  async fetch(entry, ctx) {
    const board = parseWorkdayBoardUrl(entry?.careers_url);
    if (!board) throw new Error(`workday: cannot derive board for ${entry?.name || 'company'}`);
    const apiUrl = new URL(`/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}/jobs`, board.url.origin);
    const jobs = [];
    let expectedTotal = null;
    for (let offset = 0; offset < MAX_JOBS; offset += PAGE_SIZE) {
      if (typeof ctx.fetchLimitedText !== 'function') throw new Error('workday: bounded HTTP transport is unavailable');
      const responseText = await ctx.fetchLimitedText(apiUrl.href, {
        method: 'POST', redirect: 'error', timeoutMs: 15_000,
        maxBytes: MAX_PAGE_BYTES,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appliedFacets: {}, limit: PAGE_SIZE, offset,
          searchText: String(entry.search_text || '').trim().slice(0, 120),
        }),
      });
      let json;
      try { json = JSON.parse(responseText); }
      catch { throw new Error('workday: response was not valid JSON'); }
      const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : null;
      if (!postings) throw new Error('workday: response did not contain a job list');
      if (Number.isFinite(Number(json.total))) expectedTotal = Number(json.total);
      if (expectedTotal != null && expectedTotal > MAX_JOBS) throw new Error(`workday: response exceeded ${MAX_JOBS} jobs`);
      for (const posting of postings) {
        const url = safeExternalJobUrl(board, posting?.externalPath);
        const title = typeof posting?.title === 'string' ? posting.title.trim() : '';
        if (!title || !url) continue;
        jobs.push({
          title, url, company: String(entry.name || '').trim(),
          location: typeof posting?.locationsText === 'string' ? posting.locationsText.trim() : '',
          postedAt: postedOnToIso(posting?.postedOn),
        });
        if (jobs.length > MAX_JOBS) throw new Error(`workday: response exceeded ${MAX_JOBS} jobs`);
      }
      if (postings.length < PAGE_SIZE || (expectedTotal != null && offset + postings.length >= expectedTotal)) break;
    }
    return jobs;
  },
};
