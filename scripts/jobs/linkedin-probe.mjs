#!/usr/bin/env node

// Bounded, read-only feasibility probe for the LinkedIn guest search.
// It never touches data/jobs.db and never calls Codex; it prints one compact
// JSON report describing what the public endpoint actually honours today.

import { pathToFileURL } from 'node:url';

import {
  LINKEDIN_HEADERS, LINKEDIN_POSTING_ENDPOINT, buildSearchUrl, classifySearchResponse,
  fetchWithTimeout, linkedinViewUrl, parsePostingPage, parseSearchPage,
} from './sources/linkedin.mjs';

const HOUR = 3_600;
const MAX_REQUESTS = 25;
const TA = 'Tel Aviv District, Israel';

export async function runLinkedInProbe({ fetchImpl = globalThis.fetch, log = console.error } = {}) {
  let requests = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pace = async () => { if (requests > 0) await sleep(3_000 + Math.round(Math.random() * 4_000)); };

  async function search(label, params, { headers } = {}) {
    if (requests >= MAX_REQUESTS) return { label, skipped: 'request_budget' };
    await pace();
    requests += 1;
    const url = buildSearchUrl(params);
    let response;
    let error = null;
    try { response = await fetchWithTimeout(fetchImpl, url, headers ? { headers } : {}); }
    catch (caught) { error = caught; }
    const parsed = response ? parseSearchPage(response.html) : { cards: [], listItems: 0 };
    const classification = classifySearchResponse({ ...response, cards: parsed.cards, error });
    const dates = parsed.cards.map((card) => card.listedAt).filter(Boolean);
    const result = {
      label,
      httpStatus: response?.status ?? null,
      bytes: response?.html.length ?? 0,
      classification: classification.status,
      cards: parsed.cards.length,
      listItems: parsed.listItems,
      newest: dates.length ? [...dates].sort().at(-1) : null,
      oldest: dates.length ? [...dates].sort()[0] : null,
      datesDescending: dates.every((date, index) => index === 0 || date <= dates[index - 1]),
      israelOnlyLocations: parsed.cards.filter((card) => /^israel$/i.test(card.location)).length,
      locations: [...new Set(parsed.cards.map((card) => card.location))].slice(0, 6),
      ids: parsed.cards.map((card) => card.linkedinId),
    };
    log(`[probe] ${label}: ${result.httpStatus} ${result.classification} ${result.cards} cards`);
    return result;
  }

  async function detail(label, url) {
    if (requests >= MAX_REQUESTS) return { label, skipped: 'request_budget' };
    await pace();
    requests += 1;
    try {
      const response = await fetchWithTimeout(fetchImpl, url);
      const parsed = parsePostingPage(response.html);
      log(`[probe] ${label}: ${response.status} description ${parsed.description.length} chars`);
      return {
        label,
        httpStatus: response.status,
        finalUrlHost: new URL(response.finalUrl).hostname,
        finalUrlPath: new URL(response.finalUrl).pathname.slice(0, 60),
        descriptionChars: parsed.description.length,
        title: parsed.title,
        company: parsed.company,
        hasApplyUrl: Boolean(parsed.applyUrl),
        applyHost: parsed.applyUrl ? new URL(parsed.applyUrl).hostname : null,
        closed: parsed.closed,
        criteria: Object.keys(parsed.criteria),
      };
    } catch (error) {
      return { label, error: error.name || 'error' };
    }
  }

  const report = { at: new Date().toISOString(), tpr: [], location: [], keywords: [], pagination: [], details: [], failures: [] };
  const base = { keywords: 'data engineer', location: TA };

  // 1+2. Is f_TPR honoured? Counts and date ranges must shrink with the window.
  for (const hours of [1, 24, 168]) report.tpr.push(await search(`tpr ${hours}h`, { ...base, tprSeconds: hours * HOUR }));

  // 3. Location method, and how many cards are tagged only "Israel".
  report.location.push(await search('geoId Tel Aviv District', { keywords: 'data engineer', geoId: '104243116', tprSeconds: 168 * HOUR }));
  report.location.push(await search('location Israel', { keywords: 'data engineer', location: 'Israel', tprSeconds: 168 * HOUR }));
  report.location.push(await search('geoId Israel', { keywords: 'data engineer', geoId: '101620260', tprSeconds: 168 * HOUR }));

  // 4. Do OR-queries work, compared with a single term?
  report.keywords.push(await search('backend OR query', { keywords: 'backend OR "back end" OR "server side"', location: TA, tprSeconds: 168 * HOUR }));
  report.keywords.push(await search('backend single', { keywords: 'backend', location: TA, tprSeconds: 168 * HOUR }));

  // 5+6. Sort order and pagination by cards.length.
  const first = report.tpr[2];
  let start = first.cards || 10;
  const seen = new Set(first.ids || []);
  for (let page = 1; page <= 5; page += 1) {
    const result = await search(`page ${page} start=${start}`, { ...base, tprSeconds: 168 * HOUR, start });
    const fresh = (result.ids || []).filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    report.pagination.push({ ...result, freshIds: fresh.length, ids: undefined });
    if (!result.cards) break;
    start += result.cards;
  }

  // 7. Full description and apply link: guest posting API vs public view page.
  const sampleIds = (first.ids || []).slice(0, 2);
  for (const id of sampleIds) report.details.push(await detail(`jobPosting ${id}`, `${LINKEDIN_POSTING_ENDPOINT}/${id}`));
  for (const id of sampleIds) report.details.push(await detail(`view ${id}`, linkedinViewUrl(id)));

  // 8. Failure signatures: a legitimately empty search, and bare headers.
  report.failures.push(await search('nonsense query', { keywords: 'zzqxv flurbnog', location: TA, tprSeconds: 24 * HOUR }));
  report.failures.push(await search('no browser headers', { ...base, tprSeconds: 24 * HOUR }, { headers: { 'user-agent': 'node' } }));

  for (const group of [report.tpr, report.location, report.keywords, report.failures]) {
    for (const item of group) delete item.ids;
  }
  report.requests = requests;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runLinkedInProbe()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(`LinkedIn probe failed: ${error.message}`); process.exitCode = 1; });
}
