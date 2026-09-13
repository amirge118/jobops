import { isIP } from 'node:net';

const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_DISCOVERY_SOURCE_LENGTH = 32;
const MAX_BOARD_KEY_LENGTH = 120;
const MAX_SOURCE_CONFIG_BYTES = 4_096;

export const COMPANY_STATUSES = Object.freeze(['candidate', 'watched', 'paused', 'ignored']);
export const COMPANY_SOURCE_PROVIDERS = Object.freeze([
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'recruitee',
  'smartrecruiters',
  'comeet',
  'official-html',
  'embedded-json',
  'workday',
  'zoho-recruit',
  'teamme',
  'unsupported',
]);

// These two providers scan whatever page the careers URL already points at —
// there is no separate ATS board URL to detect, so they never carry a board
// key and are exempt from the detected-URL/provider match check below.
const PROVIDERS_WITHOUT_BOARD_KEY = new Set(['official-html', 'embedded-json']);

const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan'];
const SHARED_RECRUITING_HOSTS = new Set(['comeet.com', 'teamme.link', 'dueto.io']);
const SHARED_RECRUITING_HOST_SUFFIXES = ['.teamme.link', '.dueto.io'];
const GREENHOUSE_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
  'boards-api.greenhouse.io',
]);
const SMARTRECRUITERS_HOSTS = new Set([
  'jobs.smartrecruiters.com',
  'careers.smartrecruiters.com',
]);
const TRACKING_KEYS = new Set(['gh_src', 'ref', 'referrer', 'source', 'shared_id']);

export class CompanyRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompanyRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CompanyRegistryError(code, message);
}

export function normalizeCompanyName(value) {
  const name = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) fail('invalid_company_name', 'Company name is required');
  if (name.length > MAX_NAME_LENGTH) {
    fail('invalid_company_name', `Company name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

export function normalizeCompanyIdentity(value) {
  return normalizeCompanyName(value)
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function assertPublicHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    fail('unsafe_url', 'Company URL must use a public hostname');
  }
  if (isIP(normalized)) {
    if (isPrivateIpv4(normalized)) fail('unsafe_url', 'Company URL must not use a private IP address');
    // Company sources should be stable DNS names, never raw IP addresses.
    fail('unsafe_url', 'Company URL must use a DNS hostname');
  }
  return normalized;
}

export function normalizeCompanyUrl(value, { keepQuery = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_URL_LENGTH) fail('invalid_url', `URL must contain between 1 and ${MAX_URL_LENGTH} characters`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('invalid_url', 'Company URL is invalid');
  }
  if (parsed.protocol !== 'https:') fail('unsafe_url', 'Company URL must use HTTPS');
  if (parsed.username || parsed.password) fail('unsafe_url', 'Company URL must not contain credentials');
  parsed.hostname = assertPublicHostname(parsed.hostname);
  parsed.hash = '';
  if (!keepQuery) {
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = parsed.toString();
  return parsed.pathname === '/' && !parsed.search ? normalized.replace(/\/$/, '') : normalized;
}

function normalizeBoardKey(value) {
  if (value == null || value === '') return null;
  const boardKey = String(value).normalize('NFKC').trim().toLowerCase();
  if (boardKey.length > MAX_BOARD_KEY_LENGTH || !/^[a-z0-9][a-z0-9._-]*$/.test(boardKey)) {
    fail('invalid_board_key', 'ATS board key is invalid');
  }
  return boardKey;
}

function normalizedSource(provider, boardKey, careersUrl, apiUrl = null, enabled = true, config = {}) {
  const source = {
    provider,
    boardKey: normalizeBoardKey(boardKey),
    careersUrl: normalizeCompanyUrl(careersUrl),
    apiUrl: apiUrl ? normalizeCompanyUrl(apiUrl, { keepQuery: true }) : null,
    enabled: Boolean(enabled),
  };
  return Object.keys(config).length ? { ...source, config } : source;
}

/**
 * Detect one of the public ATS URL shapes supported by scripts/providers.
 * This is deliberately pure and performs no redirect or network lookup.
 */
export function detectCompanyJobSource(value) {
  const normalizedUrl = normalizeCompanyUrl(value);
  const parsed = new URL(normalizedUrl);
  const hostname = parsed.hostname;
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (GREENHOUSE_HOSTS.has(hostname)) {
    const isApi = hostname === 'boards-api.greenhouse.io';
    const board = isApi && segments[0] === 'v1' && segments[1] === 'boards' ? segments[2] : segments[0];
    const boardKey = normalizeBoardKey(board);
    if (boardKey) {
      return normalizedSource(
        'greenhouse',
        boardKey,
        `https://job-boards.greenhouse.io/${boardKey}`,
        `https://boards-api.greenhouse.io/v1/boards/${boardKey}/jobs`,
      );
    }
  }

  if (hostname === 'jobs.lever.co' && segments[0]) {
    const boardKey = normalizeBoardKey(segments[0]);
    return normalizedSource('lever', boardKey, `https://jobs.lever.co/${segments[0]}`);
  }

  if (hostname === 'jobs.ashbyhq.com' && segments[0]) {
    const boardKey = normalizeBoardKey(segments[0]);
    return normalizedSource('ashby', boardKey, `https://jobs.ashbyhq.com/${segments[0]}`);
  }

  if (hostname === 'apply.workable.com' && segments[0]) {
    const boardKey = normalizeBoardKey(segments[0]);
    return normalizedSource('workable', boardKey, `https://apply.workable.com/${segments[0]}`);
  }

  const recruitee = hostname.match(/^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/);
  if (recruitee) {
    return normalizedSource('recruitee', recruitee[1], `https://${hostname}`);
  }

  if (SMARTRECRUITERS_HOSTS.has(hostname) && segments[0]) {
    const boardKey = normalizeBoardKey(segments[0]);
    return normalizedSource('smartrecruiters', boardKey, `https://${hostname}/${segments[0]}`);
  }

  if (hostname === 'www.comeet.com' && segments[0] === 'jobs' && segments[1] && segments[2]) {
    const uid = segments[2];
    if (/^[a-z0-9]{2}\.[a-z0-9]{3}$/i.test(uid)) {
      return normalizedSource('comeet', `${segments[1]}-${uid}`, `https://www.comeet.com/jobs/${segments[1]}/${uid}`);
    }
  }

  const workday = hostname.match(/^([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com$/);
  if (workday) {
    const localeOffset = segments[0] && /^[a-z]{2}-[a-z]{2}$/i.test(segments[0]) ? 1 : 0;
    const site = segments[localeOffset];
    if (site && site !== 'wday') {
      const boardKey = normalizeBoardKey(`${workday[1]}-${site}`);
      const locale = localeOffset ? `/${segments[0]}` : '';
      return normalizedSource('workday', boardKey, `https://${hostname}${locale}/${site}`);
    }
  }

  const zoho = hostname.match(/^([a-z0-9][a-z0-9-]*)\.zohorecruit\.com$/);
  if (zoho && segments[0]?.toLowerCase() === 'jobs' && segments[1]) {
    const boardKey = normalizeBoardKey(`${zoho[1]}-${segments[1]}`);
    return normalizedSource('zoho-recruit', boardKey, `https://${hostname}/jobs/${segments[1]}`);
  }

  const teamme = hostname.match(/^([a-z0-9][a-z0-9-]*)\.teamme\.link$/);
  if (teamme) {
    return normalizedSource('teamme', normalizeBoardKey(teamme[1]), `https://${hostname}`);
  }

  return null;
}

function normalizeProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!COMPANY_SOURCE_PROVIDERS.includes(provider)) {
    fail('invalid_provider', 'Company source provider is unsupported');
  }
  return provider;
}

function normalizeApiUrl(provider, value) {
  if (!value) return null;
  const apiUrl = normalizeCompanyUrl(value, { keepQuery: true });
  const hostname = new URL(apiUrl).hostname;
  if (provider === 'greenhouse' && hostname !== 'boards-api.greenhouse.io') {
    fail('unsafe_url', 'Greenhouse API URL must use boards-api.greenhouse.io');
  }
  if (provider !== 'greenhouse') {
    fail('invalid_api_url', 'Only Greenhouse sources accept an explicit API URL');
  }
  return apiUrl;
}

function boundedText(value, label, maxLength = 200) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (normalized.length > maxLength) fail('invalid_source_config', `${label} is too long`);
  return normalized;
}

export function normalizeCompanySourceConfig(provider, input = {}) {
  const raw = input?.config && typeof input.config === 'object' && !Array.isArray(input.config)
    ? input.config
    : input;
  const config = {};
  if (provider === 'workday') {
    const searchText = boundedText(raw.searchText ?? raw.search_text, 'Workday search text', 120);
    if (searchText) config.searchText = searchText;
  }
  if (provider === 'official-html') {
    const jobPathPrefix = boundedText(raw.jobPathPrefix ?? raw.job_path_prefix, 'Job path prefix');
    const jobPathSegments = Number(raw.jobPathSegments ?? raw.job_path_segments);
    const ignored = raw.ignoredJobPaths ?? raw.ignored_job_paths;
    if (jobPathPrefix) config.jobPathPrefix = jobPathPrefix;
    if (Number.isInteger(jobPathSegments)) config.jobPathSegments = jobPathSegments;
    if (ignored != null) {
      if (!Array.isArray(ignored) || ignored.length > 100) fail('invalid_source_config', 'Ignored job paths are invalid');
      config.ignoredJobPaths = ignored.map((item) => boundedText(item, 'Ignored job path'));
    }
    if (raw.allowEmpty === true || raw.allow_empty === true) config.allowEmpty = true;
  }
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > MAX_SOURCE_CONFIG_BYTES) {
    fail('invalid_source_config', 'Company source configuration is too large');
  }
  return config;
}

export function companySourcePortalFields(input) {
  const source = normalizeCompanySource(input);
  const config = source.config || {};
  if (source.provider === 'workday') {
    return config.searchText ? { search_text: config.searchText } : {};
  }
  if (source.provider === 'official-html') {
    return {
      ...(config.jobPathPrefix ? { job_path_prefix: config.jobPathPrefix } : {}),
      ...(Number.isInteger(config.jobPathSegments) ? { job_path_segments: config.jobPathSegments } : {}),
      ...(config.ignoredJobPaths ? { ignored_job_paths: config.ignoredJobPaths } : {}),
      ...(config.allowEmpty ? { allow_empty: true } : {}),
    };
  }
  return {};
}

export function normalizeCompanySource(input) {
  if (!input || typeof input !== 'object') fail('invalid_source', 'Company source is required');
  const careersUrl = normalizeCompanyUrl(input.careersUrl ?? input.careers_url);
  const detected = detectCompanyJobSource(careersUrl) ||
    (input.apiUrl || input.api ? detectCompanyJobSource(input.apiUrl ?? input.api) : null);
  const provider = normalizeProvider(input.provider || detected?.provider || 'unsupported');
  const boardKeyOptional = PROVIDERS_WITHOUT_BOARD_KEY.has(provider);
  if (provider !== 'unsupported' && !boardKeyOptional && (!detected || provider !== detected.provider)) {
    fail('provider_mismatch', detected
      ? `Source URL belongs to ${detected.provider}, not ${provider}`
      : `Source URL does not match the ${provider} provider`);
  }
  const boardKey = normalizeBoardKey(input.boardKey ?? input.board_key ?? detected?.boardKey);
  if (provider !== 'unsupported' && !boardKeyOptional && !boardKey) fail('invalid_board_key', 'Supported ATS source requires a board key');
  const apiUrl = normalizeApiUrl(provider, input.apiUrl ?? input.api ?? detected?.apiUrl);
  const config = normalizeCompanySourceConfig(provider, input);
  const source = {
    provider,
    boardKey,
    careersUrl: detected?.provider === provider ? detected.careersUrl : careersUrl,
    apiUrl,
    enabled: provider !== 'unsupported' && input.enabled !== false,
  };
  return Object.keys(config).length ? { ...source, config } : source;
}

export function companySourceKey(input) {
  const source = normalizeCompanySource(input);
  return source.boardKey
    ? `${source.provider}:${source.boardKey}`
    : `${source.provider}:${source.careersUrl.toLowerCase()}`;
}

export function normalizeCompanyCandidate(input) {
  if (!input || typeof input !== 'object') fail('invalid_candidate', 'Company candidate is required');
  const canonicalDomain = input.canonicalDomain == null || input.canonicalDomain === ''
    ? null
    : assertPublicHostname(String(input.canonicalDomain).trim());
  const resolutionStatus = input.resolutionStatus === 'resolved' ? 'resolved' : 'unsupported';
  return {
    name: normalizeCompanyName(input.name ?? input.company),
    canonicalDomain,
    discoverySource: normalizeDiscoverySource(input.discoverySource),
    resolutionStatus,
    status: 'candidate',
    source: input.source ? normalizeCompanySource(input.source) : null,
  };
}

function normalizeDiscoverySource(value) {
  const source = String(value || 'manual').trim().toLowerCase();
  if (!source || source.length > MAX_DISCOVERY_SOURCE_LENGTH || !/^[a-z0-9_-]+$/.test(source)) {
    fail('invalid_discovery_source', 'Discovery source is invalid');
  }
  return source;
}

export function resolveCompanyCandidate({ company, name, jobUrl, discoverySource = 'manual' } = {}) {
  const normalizedName = normalizeCompanyName(company ?? name);
  const normalizedJobUrl = normalizeCompanyUrl(jobUrl);
  const detected = detectCompanyJobSource(normalizedJobUrl);
  const hostname = new URL(normalizedJobUrl).hostname.replace(/^www\./, '');
  // Unsupported multi-tenant recruiting platforms are not company domains.
  // Treating comeet.com as a canonical identity, for example, would merge every
  // company hosted there into the first company saved in the registry.
  const sharedRecruitingHost = SHARED_RECRUITING_HOSTS.has(hostname) ||
    SHARED_RECRUITING_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  const source = detected || {
    provider: 'unsupported',
    boardKey: null,
    careersUrl: normalizedJobUrl,
    apiUrl: null,
    enabled: false,
  };

  return {
    name: normalizedName,
    canonicalDomain: detected || sharedRecruitingHost ? null : hostname,
    discoverySource: normalizeDiscoverySource(discoverySource),
    resolutionStatus: detected ? 'resolved' : 'unsupported',
    status: 'candidate',
    source,
  };
}
