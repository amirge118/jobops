#!/usr/bin/env node

// One-request LinkedIn canary (docs/linkedin-reliability-plan.md, phase 0).
// Each run sends exactly one guest job-posting request, records what LinkedIn
// answered and through which network egress, and appends it to
// data/linkedin-canary.jsonl. It reads data/jobs.db only to pick a posting id
// and to note the current cooldown; it never writes there and never calls
// Codex. Runs closer than MIN_GAP_MS apart are refused so the canary itself
// cannot keep a block alive.
//
//   npm run jobs:linkedin-canary
//   npm run jobs:linkedin-canary -- --series 5 --interval 60   # pacing test
//   npm run jobs:linkedin-canary -- --id 4474056095 --id 4469203263 --interval 60
//   npm run jobs:linkedin-canary -- --report   # summarize the log, no request
//
// A series sends up to N requests (at most MAX_SERIES), one per distinct
// posting, a fixed interval apart, and stops at the first answer that is not
// a readable posting: it measures which pacing LinkedIn accepts.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { loadJobsConfig } from './config.mjs';
import { LINKEDIN_HEADERS, LINKEDIN_POSTING_ENDPOINT, classifySearchResponse, parsePostingPage } from './sources/linkedin.mjs';

export const MIN_GAP_MS = 30 * 60 * 1000;
export const MAX_SERIES = 10;
const MIN_INTERVAL_S = 10;
const TIMEOUT_MS = 15_000;
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

// Which egress LinkedIn sees: a shared Cloudflare WARP address or the local
// connection. Only the two on/off flags are kept, never the IP itself.
export async function detectEgress(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(TRACE_URL, { signal: AbortSignal.timeout(8_000) });
    const fields = Object.fromEntries((await response.text()).split('\n').map((line) => line.split('=')));
    return { warp: fields.warp ?? null, gateway: fields.gateway ?? null };
  } catch {
    return { warp: null, gateway: null };
  }
}

export function classifyPostingResponse({ status, finalUrl = '', html = '', error = null }) {
  if (error) return error.name === 'AbortError' || error.name === 'TimeoutError' ? 'timeout' : 'network_error';
  if (status === 200) {
    const posting = parsePostingPage(html);
    if (posting.description.length >= 200) return 'ok';
    if (posting.closed) return 'closed';
  }
  if (status === 404 || status === 410) return 'not_found';
  // Same rule as the scanner: a 200 page is a block only by its sign-in URL.
  const status200 = classifySearchResponse({ status, finalUrl, html: status === 200 ? '' : html, cards: [] }).status;
  return status === 200 && status200 === 'empty' ? 'structure_changed' : status200;
}

export async function runLinkedInCanary({ jobId, fetchImpl = globalThis.fetch, now = Date.now, egress = null, cooldown = null }) {
  const startedAt = now();
  const url = `${LINKEDIN_POSTING_ENDPOINT}/${jobId}`;
  let response = null;
  let html = '';
  let error = null;
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers: LINKEDIN_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    html = await response.text();
  } catch (caught) {
    error = caught;
  }
  const finalUrl = response?.url || url;
  const result = classifyPostingResponse({ status: response?.status, finalUrl, html, error });
  return {
    at: new Date(startedAt).toISOString(),
    egress,
    jobId,
    httpStatus: response?.status ?? null,
    result,
    retryAfter: response?.headers?.get?.('retry-after') ?? null,
    finalPath: (() => { try { return new URL(finalUrl).pathname.slice(0, 40); } catch { return null; } })(),
    bytes: html.length,
    elapsedMs: now() - startedAt,
    cooldown,
  };
}

const OK_RESULTS = new Set(['ok', 'closed', 'not_found']);

export async function runLinkedInCanarySeries({ jobIds, intervalMs, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), egress = null, cooldown = null, onRecord = () => {} }) {
  const records = [];
  for (const [index, jobId] of jobIds.slice(0, MAX_SERIES).entries()) {
    if (index > 0) await sleep(intervalMs);
    const record = { ...await runLinkedInCanary({ jobId, fetchImpl, now, egress, cooldown }), series: { intervalMs, index } };
    records.push(record);
    onRecord(record);
    if (!OK_RESULTS.has(record.result)) break;
  }
  return records;
}

// Per egress: how the answers went and, for the latest block, how long it has
// lasted so far (first failure after the last success, to the latest record).
export function summarizeCanaryLog(records) {
  const byEgress = new Map();
  for (const record of records) {
    const key = record.egress?.warp === 'on' ? 'warp' : record.egress?.warp === 'off' ? 'direct' : 'unknown';
    if (!byEgress.has(key)) byEgress.set(key, []);
    byEgress.get(key).push(record);
  }
  return [...byEgress].map(([egress, items]) => {
    const counts = {};
    for (const item of items) counts[item.result] = (counts[item.result] || 0) + 1;
    const lastOk = items.findLast((item) => item.result === 'ok');
    const failing = items.filter((item) => item.result !== 'ok' && (!lastOk || item.at > lastOk.at));
    return {
      egress,
      requests: items.length,
      counts,
      lastOkAt: lastOk?.at ?? null,
      blockedSince: failing[0]?.at ?? null,
      blockedHours: failing.length ? Math.round((Date.parse(failing.at(-1).at) - Date.parse(failing[0].at)) / 36e5 * 10) / 10 : 0,
    };
  });
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const config = loadJobsConfig();
  const logPath = path.join(path.dirname(config.jobsDbPath), 'linkedin-canary.jsonl');
  const records = readLog(logPath);
  if (process.argv.includes('--report')) {
    console.log(JSON.stringify(summarizeCanaryLog(records), null, 2));
    return;
  }
  const last = records.at(-1);
  if (last && Date.now() - Date.parse(last.at) < MIN_GAP_MS && !process.argv.includes('--force')) {
    console.log(`Canary skipped: the last request was at ${last.at}; wait ${MIN_GAP_MS / 60_000} minutes between requests.`);
    return;
  }
  const flag = (name) => { const index = process.argv.indexOf(name); return index > 0 ? Number(process.argv[index + 1]) : null; };
  const seriesSize = flag('--series');
  const intervalS = flag('--interval') ?? 60;
  if (seriesSize != null && (!Number.isInteger(seriesSize) || seriesSize < 1 || seriesSize > MAX_SERIES)) {
    throw new Error(`--series must be 1-${MAX_SERIES}.`);
  }
  if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S) throw new Error(`--interval must be at least ${MIN_INTERVAL_S} seconds.`);
  const db = new Database(config.jobsDbPath, { readonly: true });
  let jobIds;
  let cooldown;
  try {
    // Postings still waiting for LinkedIn first: real, probably live ids.
    jobIds = db.prepare(`
      SELECT canonical_url AS url FROM jobs
      WHERE archived_at IS NULL AND canonical_url LIKE '%linkedin.com/jobs/view/%'
      ORDER BY (last_error_code = 'linkedin_deferred') DESC, first_seen_at DESC LIMIT ?
    `).all(seriesSize ?? 1).map((row) => row.url.match(/(\d{6,})/)?.[1]).filter(Boolean);
    const state = db.prepare('SELECT blocked_reason AS reason, blocked_at AS at, blocked_until AS until FROM linkedin_state WHERE id = 1').get();
    cooldown = state?.until > Date.now() ? { reason: state.reason, since: new Date(state.at).toISOString() } : null;
  } finally {
    db.close();
  }
  // --id: check specific postings (one series, same pacing and stop rule).
  const ids = process.argv.flatMap((arg, index) => (arg === '--id' ? [process.argv[index + 1]] : []));
  if (ids.some((id) => !/^\d{6,}$/.test(id || '')) || ids.length > MAX_SERIES) throw new Error(`--id takes 1-${MAX_SERIES} numeric posting ids.`);
  if (ids.length) jobIds = ids;
  if (!jobIds.length) throw new Error('No LinkedIn posting id found in data/jobs.db.');
  const print = (record) => {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    console.log(`LinkedIn canary${record.series ? ` #${record.series.index + 1}` : ''}: ${record.httpStatus ?? '-'} ${record.result}`
      + ` via ${record.egress.warp === 'on' ? 'WARP' : 'direct'}${record.retryAfter ? `, Retry-After ${record.retryAfter}` : ''} (${record.elapsedMs}ms)`);
  };
  const egress = await detectEgress();
  if (seriesSize == null && !ids.length) print(await runLinkedInCanary({ jobId: jobIds[0], egress, cooldown }));
  else await runLinkedInCanarySeries({ jobIds, intervalMs: intervalS * 1000, egress, cooldown, onRecord: print });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`LinkedIn canary failed: ${error.message}`); process.exitCode = 1; });
}
