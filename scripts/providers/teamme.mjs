// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const BOARD_HOST = /^([a-z0-9][a-z0-9-]*)\.teamme\.link$/i;
const MAX_HTML_BYTES = 3_000_000;
const MAX_JOBS = 5_000;

export function parseTeamMeBoardUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && BOARD_HOST.test(url.hostname) ? { url, slug: url.hostname.split('.')[0] } : null;
  } catch {
    return null;
  }
}

function validJobPosting(value) {
  return value && value['@type'] === 'JobPosting' && typeof value.title === 'string' && typeof value.url === 'string';
}

function parseJsonLd(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(validJobPosting) : validJobPosting(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function nextPayloads(html) {
  const payloads = [];
  for (const match of String(html).matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)<\/script>/gi)) {
    try {
      const frame = JSON.parse(match[1]);
      if (typeof frame?.[1] === 'string') payloads.push(frame[1]);
    } catch {
      // One malformed framework frame must not hide valid JobPosting frames.
    }
  }
  return payloads.join('\n');
}

export function extractTeamMeJobs(html, entry) {
  const text = String(html || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error(`teamme: HTML exceeds ${MAX_HTML_BYTES} bytes`);
  const board = parseTeamMeBoardUrl(entry?.careers_url);
  if (!board) throw new Error('teamme: invalid board URL');
  const postings = [];
  for (const match of text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    postings.push(...parseJsonLd(match[1]));
  }
  const decoded = nextPayloads(text);
  for (const match of decoded.matchAll(/"jobposting-\d+"[\s\S]{0,240}?"__html":"((?:\\.|[^"\\])*)"/g)) {
    try {
      const safeOuter = match[1].replace(/[\u0000-\u001f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const inner = JSON.parse(`"${safeOuter}"`).replace(/[\u0000-\u001f]/g, ' ');
      postings.push(...parseJsonLd(inner));
    } catch {
      // Ignore a malformed individual posting and continue with the board.
    }
  }
  if (postings.length > MAX_JOBS) throw new Error(`teamme: response exceeded ${MAX_JOBS} jobs`);
  const jobs = [];
  const seen = new Set();
  for (const posting of postings) {
    let jobUrl;
    let officialUrl;
    try {
      jobUrl = new URL(posting.url);
      officialUrl = new URL(posting?.hiringOrganization?.sameAs);
    } catch {
      continue;
    }
    // TeamMe can link to an external company site. Trust it only when the same
    // signed payload declares that exact site as the hiring organization.
    if (jobUrl.protocol !== 'https:' || officialUrl.protocol !== 'https:' || jobUrl.hostname !== officialUrl.hostname || seen.has(jobUrl.href)) continue;
    const title = posting.title.trim();
    if (!title) continue;
    const rawLocation = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
    const location = String(rawLocation?.address?.addressLocality || rawLocation?.address?.addressRegion || '').trim();
    seen.add(jobUrl.href);
    jobs.push({
      title, url: jobUrl.href, company: String(entry.name || posting?.hiringOrganization?.name || '').trim(), location,
      postedAt: typeof posting.datePosted === 'string' ? posting.datePosted : '',
    });
  }
  if (!jobs.length) throw new Error('teamme: no valid JobPosting records were found');
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'teamme',
  detect(entry) {
    const board = parseTeamMeBoardUrl(entry?.careers_url);
    return board ? { url: board.url.href } : null;
  },
  async fetch(entry, ctx) {
    const board = parseTeamMeBoardUrl(entry?.careers_url);
    if (!board) throw new Error(`teamme: cannot derive board for ${entry?.name || 'company'}`);
    const html = await ctx.fetchLimitedText(board.url.href, { redirect: 'error', timeoutMs: 15_000, maxBytes: MAX_HTML_BYTES });
    return extractTeamMeJobs(html, entry);
  },
};
