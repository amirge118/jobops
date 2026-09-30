import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

import { classifyLiveness } from '../liveness-core.mjs';
import {
  checkUrlLiveness, createHeadedPageProvider, isChallengeResult, newLivenessPage,
} from '../liveness-browser.mjs';
import { canonicalizeJobUrl, linkedinJobId } from './core.mjs';
import {
  DEFAULT_LINKEDIN_LIMITS, LINKEDIN_POSTING_ENDPOINT, classifySearchResponse, fetchWithTimeout, parsePostingPage,
} from './sources/linkedin.mjs';

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleApplyLabels(html) {
  const labels = [];
  for (const match of html.matchAll(/<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)) {
    labels.push(htmlToText(match[1]));
  }
  for (const match of html.matchAll(/<input\b[^>]*(?:value|aria-label)=["']([^"']+)["'][^>]*>/gi)) {
    labels.push(match[1]);
  }
  return labels.filter(Boolean);
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function hireMeTechJobId(url) {
  try {
    const parsed = new URL(url);
    if (!['hiremetech.com', 'www.hiremetech.com'].includes(parsed.hostname.toLowerCase())) return null;
    return parsed.pathname.match(/\/(?:[a-z]{2}-[a-z]{2}\/)?job\/(\d+)(?:\/|$)/i)?.[1] || null;
  } catch {
    return null;
  }
}

function smartRecruitersIdentity(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'jobs.smartrecruiters.com') return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/(\d+)(?:-|\/|$)/);
    return match ? { company: match[1], postingId: match[2] } : null;
  } catch {
    return null;
  }
}

function greenhouseIdentity(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const standardHosts = new Set([
      'boards.greenhouse.io',
      'job-boards.greenhouse.io',
      'job-boards.eu.greenhouse.io',
    ]);
    if (standardHosts.has(host)) {
      const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/);
      return match ? { board: match[1], jobId: match[2] } : null;
    }
    if (host === 'join.jfrog.com') {
      const jobId = parsed.searchParams.get('gh_jid') || parsed.searchParams.get('job');
      return /^\d+$/.test(jobId || '') ? { board: 'jfrog', jobId } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function knownNonJobReason(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (['hiremetech.com', 'www.hiremetech.com'].includes(host) && !hireMeTechJobId(url)) {
      return 'HireMeTech navigation/community link, not a job posting.';
    }
    if (['referally.link', 'www.referally.link', 'referally-jobos.lovable.app'].includes(host) && path === '/') {
      return 'Community homepage, not a job posting.';
    }
    if (['secrethunter.io', 'hire.secrethunter.io'].includes(host) && (path === '/search' || path === '/')) {
      return 'Job search/landing page, not an individual posting.';
    }
    if (['play.google.com', 'apps.apple.com'].includes(host)) {
      return 'App store link, not a job posting.';
    }
    if (['linktr.ee', 'www.linktr.ee'].includes(host)) {
      return 'Link-in-bio aggregator page, not a job posting.';
    }
    // A real Apple posting is /<locale>/details/<id>/<slug>; anything else on
    // this host (the bare root, /search, a generic landing page) is not one.
    if (host === 'jobs.apple.com' && !/^\/[a-z]{2}-[a-z]{2}\/details\/\d+/.test(path)) {
      return 'Apple careers search/landing page, not a specific job posting.';
    }
    return null;
  } catch {
    return 'Invalid URL.';
  }
}

function safeHttpUrl(value, fallback) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function compactText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(compactText).filter(Boolean).join('; ');
  if (typeof value === 'object') return Object.values(value).map(compactText).filter(Boolean).join('; ');
  return htmlToText(String(value));
}

function hireMeTechContent(job) {
  const fields = [
    ['Title', job.title],
    ['Company', job.company_name || job.company?.name],
    ['Location', job.location?.basic?.display_name || job.location?.full_address],
    ['Work model', job.location?.work_model?.display_tag || job.location?.work_model?.type],
    ['Level', job.job_level || job.ai_level],
    ['Employment', job.employment_type],
    ['Description', job.description],
    ['Requirements', job.requirements || job.skills_required],
    ['Experience', job.experience],
    ['Skills', job.extracted_skills || job.skills || job.tech_stack],
  ];
  return fields
    .map(([label, value]) => [label, compactText(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
    .slice(0, 50_000);
}

function smartRecruitersContent(posting) {
  const sections = posting.jobAd?.sections || {};
  return [
    ['Title', posting.name],
    ['Company', posting.company?.name],
    ['Location', posting.location?.fullLocation],
    ['Work model', posting.location?.hybrid ? 'Hybrid' : posting.location?.remote ? 'Remote' : 'On-site'],
    ['Description', sections.jobDescription?.text],
    ['Qualifications', sections.qualifications?.text],
    ['Additional information', sections.additionalInformation?.text],
  ]
    .map(([label, value]) => [label, compactText(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
    .slice(0, 50_000);
}

function greenhouseContent(posting) {
  return [
    ['Title', posting.title],
    ['Location', posting.location?.name],
    ['Department', posting.departments?.map((department) => department.name)],
    ['Description and requirements', posting.content],
  ]
    .map(([label, value]) => [label, compactText(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
    .slice(0, 50_000);
}

// After this many headed-retry attempts on the same host are still blocked
// within one run, stop retrying that host: a real diagnostic run showed a WAF
// (ZoomInfo) escalate from a soft 403 to hard connection-level timeouts
// (navigation_error) when hit repeatedly with the slower headed-browser path
// in a short window — likely the retries themselves reading as suspicious,
// sustained automated traffic. Failing fast for the rest of the run avoids
// making an already-hostile host worse, and every other host is unaffected.
const HEADED_RETRY_HOST_LIMIT = 2;

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// Company and title as the source states them, so a job can be matched to one
// already known before it is sent for scoring. API-backed pages carry them as
// the leading "Title:"/"Company:" lines built above; anything else is null.
function labeledIdentity(content) {
  const head = String(content || '').split('\n', 6);
  const field = (label) => head.find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2).trim() || null;
  const title = field('Title');
  const company = field('Company');
  return title || company ? { company, title } : null;
}

function jsonLdIdentity(html) {
  for (const [, raw] of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const nodes = [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
    const posting = nodes.find((node) => node && [].concat(node['@type']).includes('JobPosting'));
    if (posting?.title) {
      const organization = posting.hiringOrganization;
      return {
        title: htmlToText(String(posting.title)),
        company: typeof organization === 'string' ? organization : organization?.name ? String(organization.name) : null,
      };
    }
  }
  return null;
}

function linkedinContent(posting) {
  const criteria = Object.entries(posting.criteria).map(([name, value]) => `${name}: ${value}`).join('\n');
  return [posting.title, posting.company, posting.location, criteria, posting.description]
    .filter(Boolean).join('\n\n');
}

export function createJobPageFetcher({
  store,
  cacheTtlMs,
  fetchImpl = globalThis.fetch,
  chromiumImpl = chromium,
  linkedinLimits = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // LinkedIn postings are read through the guest posting API only — never
  // the browser path — within a per-run cap, paced, and with a breaker:
  // after one block or rate limit, the rest wait for a later retry.
  const linkedin = { ...DEFAULT_LINKEDIN_LIMITS, ...linkedinLimits, fetched: 0, haltedBy: null };
  let browser = null;
  let page = null;
  let headed = null;
  const headedRetryFailures = new Map(); // host -> still-blocked headed-retry count this run
  const headedRetryCircuitOpen = new Set(); // hosts to stop retrying for the rest of this run

  async function renderedCheck(url) {
    try {
      if (!browser) browser = await chromiumImpl.launch({ headless: true });
      if (!page) page = await newLivenessPage(browser);
      let liveness = await checkUrlLiveness(page, url);
      let activePage = page;
      const host = hostnameOf(url);
      // The plain headless check already covers most SPAs. When it specifically
      // hits an anti-bot wall (bot_challenge/access_blocked — the same class of
      // 403 that ZoomInfo and similar hosts return on every run), retry once in
      // a real, non-headless browser: this already exists and works for
      // `scan.mjs --verify --headed-fallback`, just wasn't wired into the
      // regular per-job scoring pipeline that runs on every scan. Skip it once
      // this host's circuit has tripped (see HEADED_RETRY_HOST_LIMIT above).
      if (isChallengeResult(liveness) && !(host && headedRetryCircuitOpen.has(host))) {
        if (!headed) headed = createHeadedPageProvider(chromiumImpl);
        const headedPage = await headed.get();
        if (headedPage) {
          const retried = await checkUrlLiveness(headedPage, url, { extraSettleMs: 3_000 });
          if (isChallengeResult(retried)) {
            liveness = { ...retried, reason: `${retried.reason} (headed retry also blocked)` };
            if (host) {
              const failures = (headedRetryFailures.get(host) || 0) + 1;
              headedRetryFailures.set(host, failures);
              if (failures >= HEADED_RETRY_HOST_LIMIT) headedRetryCircuitOpen.add(host);
            }
          } else {
            liveness = retried;
            activePage = headedPage;
          }
        }
      } else if (isChallengeResult(liveness) && host && headedRetryCircuitOpen.has(host)) {
        liveness = {
          ...liveness,
          reason: `${liveness.reason} (headed retry skipped — ${host} was still blocked after ${HEADED_RETRY_HOST_LIMIT} attempts this run)`,
        };
      }
      const content = await activePage.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      return { liveness, content: content.replace(/\s+/g, ' ').trim(), finalUrl: activePage.url() };
    } catch (error) {
      return {
        liveness: { result: 'uncertain', code: 'browser_error', reason: error.message.split('\n')[0] },
        content: '',
        finalUrl: url,
      };
    }
  }

  async function fetchPage(url) {
    const canonicalUrl = canonicalizeJobUrl(url);
    if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);

    const cached = store.getFreshPage(canonicalUrl, { ttlMs: cacheTtlMs });
    // Uncertain pages are dependency failures, not final decisions. Retry them on the next run.
    if (cached && cached.status !== 'uncertain') {
      return {
        canonicalUrl,
        finalUrl: cached.final_url,
        status: cached.status,
        content: cached.content,
        contentHash: cached.content_hash,
        code: 'cache',
        fromCache: true,
      };
    }

    const nonJobReason = knownNonJobReason(url);
    if (nonJobReason) {
      const result = {
        status: 'non-job',
        code: 'known_non_job_url',
        reason: nonJobReason,
        finalUrl: canonicalUrl,
        content: '',
      };
      const contentHash = hashContent(result.content);
      store.savePage({ canonicalUrl, ...result, contentHash });
      return { canonicalUrl, ...result, contentHash, fromCache: false };
    }

    const hireMeTechId = hireMeTechJobId(url);
    if (hireMeTechId) {
      const apiUrl = `https://hiremetech.com/api/jobs/${hireMeTechId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let result;
      try {
        const response = await fetchImpl(apiUrl, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (response.status === 404) {
          result = {
            status: 'expired',
            code: 'hiremetech_not_found',
            reason: 'HireMeTech reports that the job no longer exists.',
            finalUrl: canonicalUrl,
            content: '',
          };
        } else if (!response.ok) {
          result = {
            status: 'uncertain',
            code: `hiremetech_api_http_${response.status}`,
            reason: `HireMeTech API returned HTTP ${response.status}.`,
            finalUrl: canonicalUrl,
            content: '',
          };
        } else {
          const payload = await response.json();
          const job = payload?.job;
          if (!job || typeof job !== 'object') throw new Error('HireMeTech API returned no job object');
          const active = job.is_active !== false && job.accepting_applications !== false;
          result = {
            status: active ? 'active' : 'expired',
            code: 'hiremetech_api',
            reason: active ? 'Loaded from the HireMeTech public job API.' : 'HireMeTech marks the job as inactive.',
            finalUrl: safeHttpUrl(job.apply_url || job.job_url, canonicalUrl),
            content: hireMeTechContent(job),
          };
        }
      } catch (error) {
        result = {
          status: 'uncertain',
          code: error?.name === 'AbortError' ? 'hiremetech_api_timeout' : 'hiremetech_api_error',
          reason: error?.name === 'AbortError'
            ? `HireMeTech API timed out after ${FETCH_TIMEOUT_MS}ms.`
            : String(error?.message || 'HireMeTech API failed.'),
          finalUrl: canonicalUrl,
          content: '',
        };
      } finally {
        clearTimeout(timer);
      }

      const contentHash = hashContent(result.content);
      store.savePage({ canonicalUrl, ...result, contentHash });
      return { canonicalUrl, ...result, contentHash, fromCache: false };
    }

    const smartRecruiters = smartRecruitersIdentity(url);
    if (smartRecruiters) {
      const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(smartRecruiters.company)}/postings/${smartRecruiters.postingId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let result;
      try {
        const response = await fetchImpl(apiUrl, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (response.status === 404) {
          result = { status: 'expired', code: 'smartrecruiters_not_found', reason: 'SmartRecruiters reports that the job no longer exists.', finalUrl: canonicalUrl, content: '' };
        } else if (!response.ok) {
          result = { status: 'uncertain', code: `smartrecruiters_api_http_${response.status}`, reason: `SmartRecruiters API returned HTTP ${response.status}.`, finalUrl: canonicalUrl, content: '' };
        } else {
          const posting = await response.json();
          result = {
            status: 'active',
            code: 'smartrecruiters_api',
            reason: 'Loaded from the SmartRecruiters public posting API.',
            finalUrl: safeHttpUrl(posting.applyUrl || posting.postingUrl, canonicalUrl),
            content: smartRecruitersContent(posting),
          };
        }
      } catch (error) {
        result = {
          status: 'uncertain',
          code: error?.name === 'AbortError' ? 'smartrecruiters_api_timeout' : 'smartrecruiters_api_error',
          reason: error?.name === 'AbortError' ? `SmartRecruiters API timed out after ${FETCH_TIMEOUT_MS}ms.` : String(error?.message || 'SmartRecruiters API failed.'),
          finalUrl: canonicalUrl,
          content: '',
        };
      } finally {
        clearTimeout(timer);
      }
      const contentHash = hashContent(result.content);
      store.savePage({ canonicalUrl, ...result, contentHash });
      return { canonicalUrl, ...result, contentHash, fromCache: false };
    }

    const greenhouse = greenhouseIdentity(url);
    if (greenhouse) {
      const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(greenhouse.board)}/jobs/${greenhouse.jobId}?content=true`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let result;
      try {
        const response = await fetchImpl(apiUrl, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (response.status === 404) {
          result = { status: 'expired', code: 'greenhouse_not_found', reason: 'Greenhouse reports that the job no longer exists.', finalUrl: canonicalUrl, content: '' };
        } else if (!response.ok) {
          result = { status: 'uncertain', code: `greenhouse_api_http_${response.status}`, reason: `Greenhouse API returned HTTP ${response.status}.`, finalUrl: canonicalUrl, content: '' };
        } else {
          const posting = await response.json();
          result = {
            status: 'active',
            code: 'greenhouse_api',
            reason: 'Loaded from the Greenhouse public job API.',
            finalUrl: safeHttpUrl(posting.absolute_url, canonicalUrl),
            content: greenhouseContent(posting),
          };
        }
      } catch (error) {
        result = {
          status: 'uncertain',
          code: error?.name === 'AbortError' ? 'greenhouse_api_timeout' : 'greenhouse_api_error',
          reason: error?.name === 'AbortError' ? `Greenhouse API timed out after ${FETCH_TIMEOUT_MS}ms.` : String(error?.message || 'Greenhouse API failed.'),
          finalUrl: canonicalUrl,
          content: '',
        };
      } finally {
        clearTimeout(timer);
      }
      const contentHash = hashContent(result.content);
      store.savePage({ canonicalUrl, ...result, contentHash });
      return { canonicalUrl, ...result, contentHash, fromCache: false };
    }

    const linkedinId = linkedinJobId(canonicalUrl);
    if (linkedinId) {
      if (linkedin.haltedBy || linkedin.fetched >= linkedin.maxDetailFetchesPerRun) {
        return {
          canonicalUrl, finalUrl: canonicalUrl, content: '', contentHash: hashContent(''), fromCache: false,
          status: 'uncertain',
          code: 'linkedin_deferred',
          reason: linkedin.haltedBy
            ? `LinkedIn ${linkedin.haltedBy} earlier in this run; reading was postponed to the next retry.`
            : 'The per-run LinkedIn reading limit was reached; reading was postponed to the next retry.',
        };
      }
      if (linkedin.fetched > 0) {
        const [min, max] = linkedin.detailDelayMs || [2_000, 4_000];
        await sleep(Math.round(min + Math.random() * Math.max(0, max - min)));
      }
      linkedin.fetched += 1;
      let result;
      try {
        const response = await fetchWithTimeout(fetchImpl, `${LINKEDIN_POSTING_ENDPOINT}/${linkedinId}`, { timeoutMs: FETCH_TIMEOUT_MS });
        const posting = response.status === 200 ? parsePostingPage(response.html) : null;
        if (response.status === 404 || response.status === 410) {
          result = { status: 'expired', code: 'linkedin_not_found', reason: 'LinkedIn reports that the posting no longer exists.', content: '' };
        } else if (posting?.closed) {
          result = { status: 'expired', code: 'linkedin_closed', reason: 'LinkedIn marks the posting as no longer accepting applications.', content: '' };
        } else if (posting && posting.description.length >= 200) {
          if (posting.applyUrl) {
            const twin = store.recordLinkedInExternalUrl?.(linkedinId, posting.applyUrl);
            if (twin) store.markDuplicateUrl?.(canonicalUrl, twin);
          }
          result = {
            status: 'active', code: 'linkedin_posting_api', reason: 'Loaded from the LinkedIn public posting page.', content: linkedinContent(posting),
            identity: { company: posting.company || null, title: posting.title || null },
          };
        } else {
          const classification = classifySearchResponse({ ...response, cards: [] });
          const blocked = ['blocked', 'rate_limited'].includes(classification.status);
          if (blocked) linkedin.haltedBy = classification.status;
          result = {
            status: 'uncertain',
            code: blocked ? `linkedin_${classification.status}` : 'linkedin_structure_changed',
            reason: blocked ? classification.reason : 'LinkedIn returned a page without a readable job description.',
            content: '',
          };
        }
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        result = {
          status: 'uncertain',
          code: timedOut ? 'timeout' : 'network_error',
          reason: timedOut ? `LinkedIn did not answer within ${FETCH_TIMEOUT_MS}ms.` : 'LinkedIn could not be reached.',
          content: '',
        };
      }
      result.finalUrl = canonicalUrl;
      const contentHash = hashContent(result.content);
      store.savePage({ canonicalUrl, ...result, contentHash });
      return { canonicalUrl, ...result, contentHash, fromCache: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let finalUrl = url;
    let content = '';
    let liveness;
    let identity = null;
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT },
      });
      finalUrl = response.url || url;
      const html = await response.text();
      content = htmlToText(html);
      identity = jsonLdIdentity(html);
      liveness = classifyLiveness({
        status: response.status,
        finalUrl,
        bodyText: content,
        applyControls: visibleApplyLabels(html),
      });
    } catch (error) {
      liveness = { result: 'uncertain', code: 'fetch_error', reason: error.message };
    } finally {
      clearTimeout(timer);
    }

    if (liveness.result === 'uncertain') {
      const rendered = await renderedCheck(url);
      if (rendered.content.length > content.length) content = rendered.content;
      finalUrl = rendered.finalUrl || finalUrl;
      liveness = rendered.liveness;
    }

    const contentHash = hashContent(content);
    store.savePage({
      canonicalUrl,
      finalUrl,
      status: liveness.result,
      content,
      contentHash,
    });

    return {
      canonicalUrl,
      finalUrl,
      status: liveness.result,
      content,
      contentHash,
      code: liveness.code || 'liveness_uncertain',
      reason: liveness.reason,
      identity,
      fromCache: false,
    };
  }

  return {
    async fetch(url) {
      const result = await fetchPage(url);
      return { ...result, identity: result.identity ?? labeledIdentity(result.content) };
    },

    async close() {
      if (browser) await browser.close().catch(() => {});
      if (headed) await headed.close().catch(() => {});
      browser = null;
      page = null;
      headed = null;
      headedRetryFailures.clear();
      headedRetryCircuitOpen.clear();
    },
  };
}
