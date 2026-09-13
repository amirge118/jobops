// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const BOARD_PATTERN = /^https:\/\/www\.comeet\.com\/jobs\/([a-z0-9-]+)\/([a-z0-9]{2}\.[a-z0-9]{3})\/?$/i;
const API_HOST = 'www.comeet.co';
const MAX_BOARD_HTML_BYTES = 1_000_000;
const MAX_JOBS = 5_000;

export function parseComeetBoardUrl(value) {
  const match = String(value || '').match(BOARD_PATTERN);
  return match ? { slug: match[1], uid: match[2] } : null;
}

export function parseComeetBootstrap(html, expectedUid) {
  if (Buffer.byteLength(String(html || ''), 'utf8') > MAX_BOARD_HTML_BYTES) {
    throw new Error('comeet: board response exceeded 1MB');
  }
  const match = String(html || '').match(/"company_uid"\s*:\s*"([a-z0-9]{2}\.[a-z0-9]{3})"\s*,\s*"token"\s*:\s*"([a-z0-9]{16,160})"/i);
  if (!match || match[1].toLowerCase() !== String(expectedUid).toLowerCase()) {
    throw new Error('comeet: public board credentials were not found');
  }
  return { uid: match[1], token: match[2] };
}

function safeJobUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'www.comeet.com' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** @type {Provider} */
export default {
  id: 'comeet',

  detect(entry) {
    return parseComeetBoardUrl(entry.careers_url) ? { url: entry.careers_url } : null;
  },

  async fetch(entry, ctx) {
    const board = parseComeetBoardUrl(entry.careers_url);
    if (!board) throw new Error(`comeet: cannot derive board for ${entry.name}`);

    const html = await ctx.fetchText(entry.careers_url, { redirect: 'error', timeoutMs: 15_000 });
    const bootstrap = parseComeetBootstrap(html, board.uid);
    const apiUrl = new URL(`https://${API_HOST}/careers-api/2.0/company/${encodeURIComponent(bootstrap.uid)}/positions`);
    apiUrl.searchParams.set('token', bootstrap.token);
    const json = await ctx.fetchJson(apiUrl.toString(), { redirect: 'error', timeoutMs: 15_000 });
    if (!Array.isArray(json)) return [];
    if (json.length > MAX_JOBS) throw new Error(`comeet: response exceeded ${MAX_JOBS} jobs`);

    return json.map((job) => ({
      title: typeof job?.name === 'string' ? job.name : '',
      url: safeJobUrl(job?.url_comeet_hosted_page || job?.url_active_page),
      company: entry.name,
      location: typeof job?.location?.name === 'string' ? job.location.name : '',
      postedAt: typeof job?.time_updated === 'string' ? job.time_updated : '',
    })).filter((job) => job.title && job.url);
  },
};
