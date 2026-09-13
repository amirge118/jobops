import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import ashby from '../providers/ashby.mjs';
import comeet from '../providers/comeet.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import lever from '../providers/lever.mjs';
import officialHtml from '../providers/official-html.mjs';
import recruitee from '../providers/recruitee.mjs';
import smartrecruiters from '../providers/smartrecruiters.mjs';
import workable from '../providers/workable.mjs';
import workday from '../providers/workday.mjs';
import zohoRecruit from '../providers/zoho-recruit.mjs';
import teamme from '../providers/teamme.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import {
  CompanyRegistryError,
  companySourcePortalFields,
  companySourceKey,
  detectCompanyJobSource,
  normalizeCompanyName,
  normalizeCompanySource,
  normalizeCompanyUrl,
  resolveCompanyCandidate,
} from './company-registry.mjs';

const MAX_CANDIDATE_URLS = 5;
const MAX_DISCOVERED_SOURCES = 10;
const MAX_HTML_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const PAGE_TIMEOUT_MS = 15_000;

const PROVIDERS = new Map([
  ashby, comeet, greenhouse, lever, officialHtml, recruitee, smartrecruiters, workable,
  workday, zohoRecruit, teamme,
].map((provider) => [provider.id, provider]));

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && (
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function isPrivateNetworkAddress(value) {
  const address = String(value || '').toLowerCase().split('%', 1)[0];
  if (isIP(address) === 4) return privateIpv4(address);
  if (isIP(address) !== 6) return true;
  if (address === '::' || address === '::1') return true;
  if (/^(?:fc|fd)/.test(address) || /^fe[89ab]/.test(address)) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateIpv4(mapped[1]) : false;
}

async function assertPublicDns(hostname, lookupHost) {
  const addresses = await lookupHost(hostname, { all: true, verbatim: true });
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length || list.some((item) => isPrivateNetworkAddress(item?.address))) {
    throw new CompanyRegistryError('unsafe_url', 'Company URL resolved to a private network address');
  }
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CompanyRegistryError('source_too_large', `Careers page exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new CompanyRegistryError('source_too_large', `Careers page exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Fetch one untrusted public careers page with bounded redirects, DNS checks,
 * timeout, content type, and response size. Provider APIs use their own strict
 * host allowlists; this helper is only for discovering an embedded provider.
 */
export async function fetchPublicHtml(rawUrl, {
  fetchImpl = fetch,
  lookupHost = lookup,
  timeoutMs = PAGE_TIMEOUT_MS,
  maxBytes = MAX_HTML_BYTES,
} = {}) {
  let current = normalizeCompanyUrl(rawUrl, { keepQuery: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(current);
      await assertPublicDns(parsed.hostname, lookupHost);
      const response = await fetchImpl(current, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; jobops/0.1)' },
      });
      if (response.status >= 300 && response.status < 400) {
        if (hop === MAX_REDIRECTS) throw new CompanyRegistryError('redirect_limit', 'Careers page redirected too many times');
        const location = response.headers.get('location');
        if (!location) throw new CompanyRegistryError('invalid_redirect', 'Careers page returned a redirect without a location');
        current = normalizeCompanyUrl(new URL(location, current).href, { keepQuery: true });
        continue;
      }
      if (!response.ok) {
        throw new CompanyRegistryError(`http_${response.status}`, `Careers page returned HTTP ${response.status}`);
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new CompanyRegistryError('unsupported_content_type', 'Careers source did not return an HTML page');
      }
      return { url: current, html: await readBoundedBody(response, maxBytes) };
    }
    throw new CompanyRegistryError('redirect_limit', 'Careers page redirected too many times');
  } finally {
    clearTimeout(timer);
  }
}

function canonicalSupportedSourceUrl(rawValue) {
  let parsed;
  try {
    parsed = new URL(normalizeCompanyUrl(String(rawValue).replaceAll('\\/', '/'), { keepQuery: true }));
  } catch {
    return null;
  }
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(parsed.hostname)) {
    const embeddedBoard = parsed.searchParams.get('for');
    if (embeddedBoard && /^[a-z0-9._-]+$/i.test(embeddedBoard)) {
      return `https://job-boards.greenhouse.io/${embeddedBoard.toLowerCase()}`;
    }
  }
  const detected = detectCompanyJobSource(parsed.href);
  return detected?.careersUrl || null;
}

export function extractSupportedSourceCandidates(html, baseUrl) {
  const markup = String(html || '').replaceAll('&amp;', '&');
  const values = [];
  for (const match of markup.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try { values.push(new URL(match[1].replaceAll('\\/', '/'), baseUrl).href); } catch { /* ignore malformed page links */ }
  }
  for (const match of markup.matchAll(/https:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\\-]+/g)) {
    values.push(match[0].replaceAll('\\/', '/'));
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const canonical = canonicalSupportedSourceUrl(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
    if (unique.length >= MAX_DISCOVERED_SOURCES) break;
  }
  return unique;
}

function failureFrom(error) {
  const message = String(error?.message || '');
  const status = Number(error?.status);
  const code = error instanceof CompanyRegistryError ? error.code
    : status ? `http_${status}`
      : /abort|timed out/i.test(message) ? 'timeout'
        : 'provider_error';
  const reasons = {
    http_403: 'המקור חסם את הסריקה האוטומטית (HTTP 403).',
    http_404: 'לוח המשרות לא נמצא יותר (HTTP 404).',
    timeout: 'המקור לא הגיב בזמן שהוקצב לבדיקה.',
    source_too_large: 'עמוד הקריירה גדול מהגודל המותר לבדיקה.',
    unsupported_content_type: 'המקור לא החזיר עמוד HTML שניתן לבדוק.',
  };
  return { errorCode: code, reason: reasons[code] || 'לא ניתן היה לאמת את מקור המשרות.' };
}

export async function probeCompanySource(source, companyName, { httpCtx = makeHttpCtx() } = {}) {
  const normalized = normalizeCompanySource(source);
  const provider = PROVIDERS.get(normalized.provider);
  if (!provider || normalized.provider === 'unsupported') {
    return { status: 'needs_adapter', count: 0, samples: [], errorCode: 'provider_unsupported', reason: 'עדיין אין מתאם למקור הזה.' };
  }
  try {
    const jobs = await provider.fetch({
      name: normalizeCompanyName(companyName),
      careers_url: normalized.careersUrl,
      provider: normalized.provider,
      ...(normalized.apiUrl ? { api: normalized.apiUrl } : {}),
      ...companySourcePortalFields(normalized),
    }, httpCtx);
    if (!Array.isArray(jobs) || jobs.length > 5_000) throw new Error('Provider returned an invalid job list');
    const samples = jobs.slice(0, 3).map((job) => ({ title: String(job.title || '').slice(0, 200), url: String(job.url || '') }));
    return {
      status: jobs.length ? 'verified_jobs' : 'verified_empty',
      count: jobs.length,
      samples,
      errorCode: null,
      reason: jobs.length ? `נמצאו ${jobs.length} משרות במקור שנבדק.` : 'המקור תקין, אך אין בו כרגע משרות פתוחות.',
    };
  } catch (error) {
    return { status: 'failed', count: 0, samples: [], ...failureFrom(error) };
  }
}

function configureDetectedSource(source, companyName) {
  if (source.provider !== 'workday') return source;
  const tenant = String(source.boardKey || '').split('-', 1)[0].replace(/[^a-z0-9]/g, '');
  const identity = normalizeCompanyName(companyName).toLowerCase().replace(/[^a-z0-9]/g, '');
  // A different tenant usually means an acquired brand on its parent's board.
  // Workday's search endpoint can scope that shared board without company code.
  if (tenant && identity && !tenant.includes(identity) && !identity.includes(tenant)) {
    return normalizeCompanySource({ ...source, config: { searchText: companyName } });
  }
  return source;
}

function normalizedUrlList(values, maxItems) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxItems) {
    throw new CompanyRegistryError('invalid_research_urls', `Company research must return between 1 and ${maxItems} candidate URLs`);
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const url = normalizeCompanyUrl(value, { keepQuery: true });
    if (!seen.has(url)) { seen.add(url); unique.push(url); }
  }
  return unique;
}

export function createCompanySourceResolver({
  fetchPage = fetchPublicHtml,
  probeSource = probeCompanySource,
} = {}) {
  return async function resolveCompanySource({ companyName: rawName, candidateUrls, evidenceUrls = [] }) {
    const companyName = normalizeCompanyName(rawName);
    const candidates = normalizedUrlList(candidateUrls, MAX_CANDIDATE_URLS);
    const evidence = Array.isArray(evidenceUrls)
      ? evidenceUrls.slice(0, 3).map((url) => normalizeCompanyUrl(url, { keepQuery: true }))
      : [];
    const supportedUrls = [];
    const supportedSeen = new Set();
    const addSupported = (url) => {
      const canonical = canonicalSupportedSourceUrl(url);
      if (canonical && !supportedSeen.has(canonical)) {
        supportedSeen.add(canonical);
        supportedUrls.push(canonical);
      }
    };
    [...candidates, ...evidence].forEach(addSupported);

    const pageFailures = [];
    let fetchedPage = false;
    for (const url of candidates.filter((value) => !canonicalSupportedSourceUrl(value)).slice(0, 3)) {
      try {
        const page = await fetchPage(url);
        fetchedPage = true;
        addSupported(page.url);
        extractSupportedSourceCandidates(page.html, page.url).forEach(addSupported);
      } catch (error) {
        pageFailures.push(failureFrom(error));
      }
    }

    const attempts = [];
    for (const url of supportedUrls.slice(0, MAX_DISCOVERED_SOURCES)) {
      const detected = detectCompanyJobSource(url);
      if (!detected) continue;
      const source = configureDetectedSource(normalizeCompanySource(detected), companyName);
      const probe = await probeSource(source, companyName);
      attempts.push({ source, probe });
    }
    const verified = attempts
      .filter(({ probe }) => ['verified_jobs', 'verified_empty'].includes(probe.status))
      .sort((left, right) => (right.probe.count || 0) - (left.probe.count || 0))[0];
    const selected = verified || attempts[0];
    if (selected) {
      const source = normalizeCompanySource({ ...selected.source, enabled: Boolean(verified) });
      const candidate = resolveCompanyCandidate({ company: companyName, jobUrl: source.careersUrl, discoverySource: 'research' });
      candidate.source = source;
      return { candidate, probe: selected.probe, attemptedSources: attempts.length, evidenceUrls: evidence };
    }

    const candidate = resolveCompanyCandidate({ company: companyName, jobUrl: candidates[0], discoverySource: 'research' });
    const failure = pageFailures[0];
    const probe = failure && !fetchedPage
      ? { status: failure.errorCode === 'http_403' ? 'blocked' : 'failed', count: 0, samples: [], ...failure }
      : { status: 'needs_adapter', count: 0, samples: [], errorCode: 'provider_unsupported', reason: 'נמצא עמוד קריירה, אך עדיין אין מתאם למקור הזה.' };
    return { candidate, probe, attemptedSources: 0, evidenceUrls: evidence };
  };
}
