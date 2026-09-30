import { createHash } from 'node:crypto';

const TRACKING_KEYS = new Set([
  'coref',
  'gh_src',
  'lever-social',
  'lever-via',
  'ref',
  'referrer',
  'shared_id',
  'source',
]);

function isTrackingKey(key) {
  const normalized = key.toLowerCase();
  return normalized.startsWith('utm_') || TRACKING_KEYS.has(normalized);
}

const LINKEDIN_HOST = /(?:^|\.)linkedin\.com$/i;

// LinkedIn exposes one posting under many URLs: country subdomains
// (il.linkedin.com), slugged paths (/jobs/view/backend-engineer-at-x-123),
// search-page deep links (?currentJobId=123) and per-impression tracking
// params. The numeric posting id is the only stable identity.
export function linkedinJobId(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!LINKEDIN_HOST.test(parsed.hostname)) return null;
  const fromPath = parsed.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/)?.[1] ||
    parsed.pathname.match(/^\/jobs-guest\/jobs\/api\/jobPosting\/(\d{6,})\/?$/)?.[1];
  if (fromPath) return fromPath;
  const current = parsed.searchParams.get('currentJobId');
  return /^\d{6,}$/.test(current || '') && /^\/jobs(?:\/|$)/.test(parsed.pathname) ? current : null;
}

export function canonicalizeJobUrl(value) {
  if (!value) return '';

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  const linkedinId = linkedinJobId(value);
  if (linkedinId) return `https://www.linkedin.com/jobs/view/${linkedinId}`;

  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  const meaningful = [...parsed.searchParams.entries()]
    .filter(([key]) => !isTrackingKey(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));

  parsed.search = '';
  for (const [key, valuePart] of meaningful) parsed.searchParams.append(key, valuePart);

  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

function normalizeIdentityPart(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Values the pipeline writes when it does not know the real company/title.
// Matching on them would merge every unidentified job into one.
const PLACEHOLDER_IDENTITIES = new Set([
  'unknown',
  'unknown company',
  'unknown role',
  'n a',
  'חברה לא ידועה',
  'משרה לא ידועה',
  'משרה לא מזוהה',
  'חברה לא מזוהה',
]);

// Legal/generic trailing words: "Check Point Software Technologies Ltd" and
// "Check Point" are one employer. Only trailing tokens are stripped, and
// never down to an empty name.
const COMPANY_SUFFIX = /\s+(?:ltd|limited|inc|incorporated|llc|corp|corporation|co|plc|gmbh|technologies|technology|software|group|israel|il|io|com|ai|בע מ|ישראל)$/u;

function normalizeCompanyKey(value) {
  let name = normalizeIdentityPart(value);
  for (let next = name.replace(COMPANY_SUFFIX, ''); next && next !== name; next = name.replace(COMPANY_SUFFIX, '')) {
    name = next;
  }
  return name;
}

function normalizeTitleKey(value) {
  return normalizeIdentityPart(value)
    .replace(/(^| )sr( |$)/g, '$1senior$2')
    .replace(/(^| )jr( |$)/g, '$1junior$2');
}

export function isPlaceholderIdentity(company, title) {
  const companyPart = normalizeIdentityPart(company);
  const titlePart = normalizeIdentityPart(title);
  return !companyPart || !titlePart ||
    PLACEHOLDER_IDENTITIES.has(companyPart) || PLACEHOLDER_IDENTITIES.has(titlePart);
}

// The company half of the identity key; '' when the company is unknown.
export function companyIdentityKey(company) {
  const part = normalizeIdentityPart(company);
  return !part || PLACEHOLDER_IDENTITIES.has(part) ? '' : normalizeCompanyKey(company);
}

// '::' means "no usable identity" and must never be matched against.
export function normalizeCompanyRole(company, title) {
  if (isPlaceholderIdentity(company, title)) return '::';
  return `${normalizeCompanyKey(company)}::${normalizeTitleKey(title)}`;
}

export function deduplicateJobs(jobs) {
  const seenUrls = new Set();
  const seenRoles = new Set();
  const unique = [];

  for (const job of jobs) {
    const canonicalUrl = canonicalizeJobUrl(job.applyUrl || job.url);
    const companyRole = normalizeCompanyRole(job.company, job.title);
    const hasIdentity = companyRole !== '::';
    if ((canonicalUrl && seenUrls.has(canonicalUrl)) || (hasIdentity && seenRoles.has(companyRole))) {
      continue;
    }
    if (canonicalUrl) seenUrls.add(canonicalUrl);
    if (hasIdentity) seenRoles.add(companyRole);
    unique.push(job);
  }

  return unique;
}

export function calculateFitScore({ cvMatch, seniority, roleScope, location, sector }) {
  const weighted =
    Number(cvMatch) * 0.55 +
    Number(seniority) * 0.15 +
    Number(roleScope) * 0.10 +
    Number(location) * 0.15 +
    Number(sector) * 0.05;

  return Math.round(Math.max(1, Math.min(5, weighted)) * 10) / 10;
}

export function decideFit({
  score,
  isActive,
  domainMatches,
  locationMatches,
  hasApplyUrl,
  minimumScore = 4,
  exactMatchScore = 4.5,
}) {
  const passesBasicGates = Boolean(isActive && domainMatches && locationMatches && hasApplyUrl);
  if (!passesBasicGates || Number(score) < Number(minimumScore)) {
    return { suitable: false, label: 'לא מתאים' };
  }
  if (Number(score) >= Number(exactMatchScore)) {
    return { suitable: true, label: 'בול מתאים' };
  }
  return { suitable: true, label: 'מתאים' };
}

export function resumeGapInputHash({
  contentHash,
  profileHash,
  resumeHash,
  analysisVersion,
}) {
  return createHash('sha256').update(JSON.stringify({
    contentHash: String(contentHash || ''),
    profileHash: String(profileHash || ''),
    resumeHash: String(resumeHash || ''),
    analysisVersion: String(analysisVersion || ''),
  })).digest('hex');
}
