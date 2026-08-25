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

export function canonicalizeJobUrl(value) {
  if (!value) return '';

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return '';

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

export function normalizeCompanyRole(company, title) {
  return `${normalizeIdentityPart(company)}::${normalizeIdentityPart(title)}`;
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
    Number(cvMatch) * 0.5 +
    Number(seniority) * 0.2 +
    Number(roleScope) * 0.15 +
    Number(location) * 0.1 +
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
