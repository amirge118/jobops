// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const BOARD_HOST = /^([a-z0-9][a-z0-9-]*)\.zohorecruit\.com$/i;
const MAX_HTML_BYTES = 3_000_000;
const MAX_JOBS = 5_000;

export function parseZohoRecruitBoardUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || !BOARD_HOST.test(url.hostname) || segments[0]?.toLowerCase() !== 'jobs' || !segments[1]) return null;
    return { url, portal: segments[1], basePath: `/jobs/${segments[1]}` };
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff)))
    .replace(/&quot;|&#34;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function jobSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'job';
}

export function extractZohoRecruitJobs(html, entry) {
  const text = String(html || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error(`zoho-recruit: HTML exceeds ${MAX_HTML_BYTES} bytes`);
  const board = parseZohoRecruitBoardUrl(entry?.careers_url);
  if (!board) throw new Error('zoho-recruit: invalid careers board URL');
  const input = [...text.matchAll(/<input\b[^>]*>/gi)].find((match) => /\bid\s*=\s*["']jobs["']/i.test(match[0]));
  const value = input?.[0].match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!value) throw new Error('zoho-recruit: embedded jobs payload was not found');
  let payload;
  try {
    payload = JSON.parse(decodeHtmlAttribute(value[1] ?? value[2] ?? ''));
  } catch {
    throw new Error('zoho-recruit: embedded jobs payload was malformed');
  }
  if (!Array.isArray(payload)) throw new Error('zoho-recruit: jobs payload was not an array');
  if (payload.length > MAX_JOBS) throw new Error(`zoho-recruit: response exceeded ${MAX_JOBS} jobs`);
  return payload.map((job) => {
    const id = String(job?.id || '').trim();
    const title = String(job?.Posting_Title || job?.Job_Opening_Name || '').trim();
    if (!/^\d{6,30}$/.test(id) || !title) return null;
    const url = new URL(`${board.basePath}/${id}/${encodeURIComponent(jobSlug(title))}`, board.url.origin);
    const location = [job?.City, job?.State, job?.Country].filter((part) => typeof part === 'string' && part.trim()).join(', ');
    return {
      title, url: url.href, company: String(entry.name || '').trim(), location,
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(job?.Date_Opened || '')) ? `${job.Date_Opened}T00:00:00.000Z` : '',
    };
  }).filter(Boolean);
}

/** @type {Provider} */
export default {
  id: 'zoho-recruit',
  detect(entry) {
    const board = parseZohoRecruitBoardUrl(entry?.careers_url);
    return board ? { url: board.url.href } : null;
  },
  async fetch(entry, ctx) {
    const board = parseZohoRecruitBoardUrl(entry?.careers_url);
    if (!board) throw new Error(`zoho-recruit: cannot derive board for ${entry?.name || 'company'}`);
    const html = await ctx.fetchLimitedText(board.url.href, { redirect: 'error', timeoutMs: 15_000, maxBytes: MAX_HTML_BYTES });
    return extractZohoRecruitJobs(html, entry);
  },
};
