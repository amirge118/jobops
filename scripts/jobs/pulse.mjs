#!/usr/bin/env node

// /pulse data collector: one read-only, token-free snapshot of how jobOps is
// doing right now — services, WhatsApp collector, LinkedIn, ATS, Codex, the
// machine — plus how many jobs were read recently, and a list of `signals`:
// anomalies with a stable key that .claude/skills/pulse/SKILL.md maps to a
// cause and an action. It never writes anything and never calls Codex; the
// only network request is Cloudflare's trace (egress flags, never the IP).
//
//   npm run jobs:pulse            # JSON for the /pulse skill
//   npm run jobs:pulse -- --text  # short human summary

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';
import { inShabbatQuiet } from './health-check.mjs';
import { SCHEDULES } from './scheduled-scan-service.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TIME_ZONE = 'Asia/Jerusalem';
const DEAD_COLLECTOR = ['interrupted', 'unconfirmed', 'stopped', 'failed', 'pairing_required'];
const ALWAYS_ON_AGENTS = ['com.amirgefen.jobops.whatsapp-collector', 'com.amirgefen.jobops.dashboard'];

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const local = (ms) => (ms ? new Date(Number(ms)).toLocaleString('he-IL', { timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);
const minutesAgo = (now, ms) => (ms ? Math.round((now - Number(ms)) / MIN) : null);
const israelHour = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(ms));

function run(command, args, { timeout = 10_000 } = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// Each section is collected on its own: one broken source of data must not
// hide the others. A failed section reports { error } instead.
async function section(fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200) };
  }
}

export function parseLaunchctlList(text, labels) {
  const rows = new Map();
  for (const line of String(text || '').split('\n')) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (label) rows.set(label, { pid: pid === '-' ? null : Number(pid), lastExit: Number(status) });
  }
  return labels.map((label) => ({ label, loaded: rows.has(label), ...(rows.get(label) || { pid: null, lastExit: null }) }));
}

// `pmset -g log` lines start with "YYYY-MM-DD HH:MM:SS ±zzzz"; count full
// sleeps and short dark wakes since `sinceMs` (scheduled jobs that fire in a
// dark wake have no network yet).
export function summarizePowerLog(text, sinceMs) {
  let sleeps = 0;
  let darkWakes = 0;
  let lastSleepAt = null;
  const sleepHours = new Set();
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(Sleep|DarkWake|Wake)\s/);
    if (!match) continue;
    const at = Date.parse(match[1].replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (!(at >= sinceMs)) continue;
    if (match[2] === 'Sleep') { sleeps += 1; lastSleepAt = at; sleepHours.add(israelHour(at)); }
    if (match[2] === 'DarkWake') darkWakes += 1;
  }
  return { sleeps, darkWakes, lastSleepAt: iso(lastSleepAt), sleepHoursLocal: [...sleepHours].sort((a, b) => a - b) };
}

// The last report block of a scheduled log: its "N שגיאות" error count and
// any line saying a run failed.
export function lastAtsRun(logText) {
  const blocks = String(logText || '').split(/(?=^ATS: \d+ מועמדויות)/m).filter((block) => /^ATS: \d+ מועמדויות/.test(block));
  const last = blocks.at(-1);
  if (!last) return null;
  const header = last.match(/^ATS: (\d+) מועמדויות מתוך (\d+) משרות ב-(\d+) חברות; (\d+) שגיאות/);
  const report = last.match(/reports\/daily\/(\S+)\.md/)?.[1] ?? null;
  return header ? { candidates: Number(header[1]), jobs: Number(header[2]), companies: Number(header[3]), errors: Number(header[4]), report } : null;
}

function tail(file, bytes = 40_000) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    return { text: buffer.toString('utf8'), modifiedAt: stat.mtimeMs };
  } catch {
    return { text: '', modifiedAt: null };
  }
}

// Where a job came from: its sources, or — for a rejected job, which keeps no
// sources_json — its latest sighting. A LinkedIn posting is counted as
// LinkedIn even when it was shared on WhatsApp.
export function sourceKind(sourcesJson, url, sightingKind = null) {
  if (/linkedin\.com\/jobs\/view/i.test(url || '')) return 'linkedin';
  const first = (() => { try { return JSON.parse(sourcesJson || '[]')[0] || ''; } catch { return ''; } })();
  if (/^WhatsApp:/i.test(first)) return 'whatsapp';
  if (/^LinkedIn:/i.test(first)) return 'linkedin';
  if (/^ATS:/i.test(first)) return 'ats';
  return ['whatsapp', 'linkedin', 'ats'].includes(sightingKind) ? sightingKind : 'unknown';
}

export async function collectPulse({ store, config, now = Date.now(), launchctlText = null, powerLogText = null, batteryText = null, egress = null, logs = {} }) {
  const linkedinLimits = config.sources?.linkedin?.limits || {};

  const services = await section(() => {
    const labels = [...SCHEDULES.map((schedule) => schedule.label), ...ALWAYS_ON_AGENTS];
    return parseLaunchctlList(launchctlText, labels);
  });

  const machine = await section(() => ({
    onAC: batteryText == null ? null : /AC Power/.test(batteryText),
    last24h: summarizePowerLog(powerLogText, now - DAY),
    egress,
  }));

  const collector = await section(async () => {
    const facts = await store.pulseCollectorFacts(now);
    if (!facts) return { status: 'never_ran' };
    const { run: row, lastFailure } = facts;
    const failure = (() => { try { return JSON.parse(lastFailure?.details_json || '{}'); } catch { return {}; } })();
    return {
      run: row.id,
      status: row.status,
      startedAt: iso(row.started_at),
      heartbeatMinutesAgo: minutesAgo(now, row.heartbeat_at),
      connectedAt: iso(row.connected_at),
      lastMessageMinutesAgo: minutesAgo(now, row.last_message_at),
      messagesThisRun: row.messages_received,
      reconnectsThisRun: row.reconnects,
      reconnectsLast6h: facts.reconnectsLast6h,
      connectFailuresLast6h: facts.connectFailuresLast6h,
      decryptFailuresLast6h: facts.decryptFailuresLast6h,
      lastDisconnect: lastFailure ? { at: iso(lastFailure.created_at), code: failure.code ?? null, statusCode: failure.statusCode ?? null, stream: failure.stream?.message ?? null } : null,
    };
  });

  const whatsapp = await section(async () => {
    const facts = await store.pulseWhatsAppFacts(now);
    return {
      groupMessagesLast1h: facts.last1h,
      groupMessagesLast6h: facts.last6h,
      groupMessagesLast24h: facts.last24h,
      lastGroupMessageMinutesAgo: minutesAgo(now, facts.lastMessageAt),
      backlogPending: facts.pending.n,
      backlogOldestMinutes: minutesAgo(now, facts.pending.oldest),
    };
  });

  const alerts = await section(async () => {
    const { deliverable, expired7d } = await store.pulseAlertFacts(now);
    return { unsent: deliverable.n, oldestUnsentMinutes: minutesAgo(now, deliverable.oldest), expiredUnsentLast7d: expired7d };
  });

  const linkedin = await section(async () => {
    const facts = await store.pulseLinkedInFacts(now);
    const { state, queue, refusals24h, postingsEvaluated24h } = facts;
    const requests = {
      last1h: facts.sentLast1h,
      last24h: facts.sentLast24h,
      lastSearchMinutesAgo: minutesAgo(now, facts.lastSearchAt),
      busiestHourLast24h: facts.busiestHourLast24h,
      refusals: facts.refusals.map((row) => {
        const detail = (() => { try { return JSON.parse(row.detail || 'null'); } catch { return null; } })();
        // recovered: the one retry after Retry-After succeeded (since 2026-10-24).
        return { at: iso(row.at), reason: row.reason, lastHour: row.lastHour, last10min: row.last10min,
          ...(detail ? { recovered: Boolean(detail.recovered), retryAfter: detail.retryAfter ?? null, status: detail.status ?? null } : {}) };
      }),
    };
    const requestLogSince = iso(facts.requestLogSince);
    return {
      cooldown: state.blocked_until > now ? { reason: state.blocked_reason, until: iso(state.blocked_until), sinceMinutes: minutesAgo(now, state.blocked_at) } : null,
      lastBlock: state.blocked_at ? { reason: state.blocked_reason, at: iso(state.blocked_at), minutesAgo: minutesAgo(now, state.blocked_at) } : null,
      queue: Object.fromEntries(queue.map((row) => [row.code, row.n])),
      requests,
      hourlyCap: Number(linkedinLimits.maxRequestsPerHour ?? 10),
      refusals24h: Object.fromEntries(refusals24h.map((row) => [row.code, row.n])),
      postingsEvaluated24h,
      requestLogSince,
    };
  });

  const ats = await section(() => {
    const last = lastAtsRun(logs.ats?.text);
    return last ? { ...last, logUpdatedMinutesAgo: minutesAgo(now, logs.ats?.modifiedAt) } : { lastRun: null };
  });

  const codex = await section(async () => {
    const { calls, blocked } = await store.pulseCodexFacts(now);
    const failed = calls.filter((call) => !call.ok);
    return {
      calls24h: calls.length,
      failed24h: failed.length,
      lastFailure: failed[0] ? { code: failed[0].code, reason: String(failed[0].reason || '').slice(0, 160), at: iso(failed[0].at) } : null,
      quotaBlockedUntil: blocked?.until > now ? iso(blocked.until) : null,
    };
  });

  const runs = await section(async () => {
    const { stuck, running } = await store.pulseRunFacts(now);
    return { stuck: stuck.map((run) => ({ id: run.id, sources: run.sources, stage: run.stage, heartbeatMinutesAgo: minutesAgo(now, run.heartbeat) })), running };
  });

  const jobs = await section(async () => {
    const { evaluated24h: rows, newSuitable24h, evaluated6h, failing } = await store.pulseJobFacts(now);
    const read24h = {};
    for (const row of rows) {
      const kind = sourceKind(row.sources_json, row.canonical_url, row.sightingKind);
      read24h[kind] ??= { evaluated: 0, newSuitable: 0 };
      read24h[kind].evaluated += 1;
      if (row.suitableAt >= now - DAY) read24h[kind].newSuitable += 1;
    }
    return { read24h, evaluated6h, newSuitable24h, failingNow: Object.fromEntries(failing.map((row) => [row.code, row.n])) };
  });

  const health = await section(async () => (await store.listOpenHealthFindings())
    .map((finding) => ({ ...finding, since: iso(finding.since) })));

  const snapshot = { at: iso(now), local: local(now), services, machine, collector, whatsapp, alerts, linkedin, ats, codex, runs, jobs, health };
  return { ...snapshot, signals: deriveSignals(snapshot, { now }) };
}

// Anomalies with stable keys; the /pulse skill maps each key to its likely
// cause and action. Thresholds are deliberately earlier than the hourly
// health check's: /pulse is asked "is something wrong right now?".
export function deriveSignals(s, { now = Date.now() } = {}) {
  const out = [];
  const add = (key, severity, evidence) => out.push({ key, severity, evidence });
  const daytime = (() => { const hour = israelHour(now); return hour >= 8 && hour <= 23; })();

  if (Array.isArray(s.services)) {
    for (const service of s.services) {
      if (!service.loaded) add('service.not_loaded', 'error', `${service.label} is not loaded in launchd`);
      else if (service.lastExit && service.lastExit !== 0 && !service.pid) add('service.last_exit_failed', 'warn', `${service.label} last exited with status ${service.lastExit}`);
    }
  }

  const c = s.collector || {};
  if (c.status === 'never_ran' || DEAD_COLLECTOR.includes(c.status)) {
    add(c.status === 'pairing_required' ? 'collector.pairing_required' : 'collector.down', 'error', `collector status ${c.status}`);
  } else if (c.status) {
    if (c.heartbeatMinutesAgo != null && c.heartbeatMinutesAgo > 5) add('collector.stale_heartbeat', 'error', `heartbeat ${c.heartbeatMinutesAgo} min ago (status ${c.status})`);
    if (c.status !== 'connected' && c.connectFailuresLast6h >= 3) add('collector.cannot_connect', 'error', `${c.connectFailuresLast6h} connect failures in 6h, last: ${c.lastDisconnect?.code || '?'}`);
    if (c.reconnectsLast6h > 12) add('collector.flapping', 'warn', `${c.reconnectsLast6h} reconnects in 6h`);
    if (c.decryptFailuresLast6h > 30) add('collector.decrypt_failures', 'warn', `${c.decryptFailuresLast6h} decrypt-failure events in 6h`);
  }
  const w = s.whatsapp || {};
  if (daytime && !inShabbatQuiet(now) && c.status && !DEAD_COLLECTOR.includes(c.status) && w.lastGroupMessageMinutesAgo != null && w.lastGroupMessageMinutesAgo > 180) {
    add('whatsapp.silent', 'error', `no group message for ${Math.round(w.lastGroupMessageMinutesAgo / 60)}h while the collector is ${c.status}`);
  }
  if (w.backlogOldestMinutes != null && w.backlogOldestMinutes > 150) add('whatsapp.backlog_waiting', 'warn', `${w.backlogPending} messages pending, oldest ${w.backlogOldestMinutes} min`);
  if (s.alerts?.unsent > 0 && s.alerts.oldestUnsentMinutes > 60) add('alerts.unsent', 'warn', `${s.alerts.unsent} WhatsApp alerts waiting to be sent, oldest ${s.alerts.oldestUnsentMinutes} min`);
  if (s.alerts?.expiredUnsentLast7d > 0) add('alerts.expired', 'info', `${s.alerts.expiredUnsentLast7d} alerts in the last 7 days expired unsent (collector was down)`);

  const l = s.linkedin || {};
  if (l.cooldown) add('linkedin.cooldown', 'info', `cooling down after ${l.cooldown.reason} until ${l.cooldown.until}`);
  const refusals = Object.values(l.refusals24h || {}).reduce((sum, n) => sum + n, 0);
  if (refusals >= 3) add('linkedin.refusals', 'warn', `${refusals} refused postings in 24h (${JSON.stringify(l.refusals24h)})`);
  const busiest = l.requests?.busiestHourLast24h?.n ?? 0;
  if (busiest > (l.hourlyCap ?? 10)) add('linkedin.over_cap', 'error', `${busiest} requests in one hour, above the cap of ${l.hourlyCap}`);
  // Refused below the cap: LinkedIn tolerates less than maxRequestsPerHour,
  // often a few requests close together (2026-10-20: the 3rd of 3 requests
  // 2-3 minutes apart, with 6 in the hour).
  const recovered = (l.requests?.refusals || []).filter((refusal) => refusal.recovered);
  if (recovered.length) add('linkedin.refusals_recovered', 'info', `${recovered.length} 429s in 24h were waited out and retried successfully`);
  const underCap = (l.requests?.refusals || []).filter((refusal) => !refusal.recovered && refusal.lastHour < (l.hourlyCap ?? 10));
  if (underCap.length) add('linkedin.refused_under_cap', 'warn', `${underCap.length} refusals in 24h below the cap of ${l.hourlyCap}: `
    + underCap.map((refusal) => `${refusal.at.slice(11, 16)}Z after ${refusal.lastHour}/h, ${refusal.last10min} in 10 min`).join('; '));
  // Searches need several requests in a row; the queue reader can use the hour first.
  const searches24h = (l.requests?.last24h || []).find((row) => row.kind === 'search')?.n ?? 0;
  // Scans run every 2 hours with several pages each; <= 2 search requests over
  // a log that covers 6+ hours means searches keep being cut off.
  const logHours = l.requestLogSince ? (now - Date.parse(l.requestLogSince)) / HOUR : 0;
  if (daytime && l.requests && logHours >= 6 && searches24h <= 2) {
    add('linkedin.search_starved', 'warn', `only ${searches24h} search requests in 24h, last ${l.requests.lastSearchMinutesAgo ?? '-'} min ago`);
  }
  const queued = l.queue?.linkedin_deferred ?? 0;
  const postings24h = (l.requests?.last24h || []).find((row) => row.kind === 'posting')?.n ?? 0;
  if (queued > 20 && postings24h === 0 && !l.cooldown) add('linkedin.queue_stalled', 'error', `${queued} postings queued and none read in 24h`);
  if (l.requests === null) add('linkedin.no_request_log', 'info', 'linkedin_requests table missing: no run since the hourly cap was installed');

  const a = s.ats || {};
  if (a.companies && a.errors / a.companies >= 0.5) add('ats.mass_failure', 'error', `${a.errors}/${a.companies} companies failed in the last ATS run (${a.report})`);
  else if (a.errors > 3) add('ats.some_failures', 'info', `${a.errors} companies failed in the last ATS run`);
  if (daytime && a.logUpdatedMinutesAgo != null && a.logUpdatedMinutesAgo > 150) add('ats.not_running', 'warn', `ATS log not updated for ${a.logUpdatedMinutesAgo} min`);

  const x = s.codex || {};
  if (x.quotaBlockedUntil) add('codex.quota', 'error', `Codex quota blocked until ${x.quotaBlockedUntil}`);
  else if (x.failed24h >= 3) add('codex.failures', 'warn', `${x.failed24h}/${x.calls24h} Codex calls failed in 24h; last: ${x.lastFailure?.code} ${x.lastFailure?.reason}`);

  for (const stuck of s.runs?.stuck || []) add('runs.stuck', 'error', `run ${stuck.id} ${stuck.sources} stuck in ${stuck.stage}, heartbeat ${stuck.heartbeatMinutesAgo} min ago`);

  const m = s.machine || {};
  if (m.onAC === false) add('machine.on_battery', 'warn', 'on battery: the Mac may sleep and scheduled runs fire without network');
  // Sleep matters when scheduled runs fire (08-23 local); a night's sleep does not.
  const daySleeps = (m.last24h?.sleepHoursLocal || []).filter((hour) => hour >= 8 && hour <= 23);
  if (daySleeps.length) add('machine.slept', 'warn', `${m.last24h.sleeps} sleeps in 24h, during scheduled hours ${daySleeps.join(',')}; last ${m.last24h.lastSleepAt}`);
  if (m.egress?.warp === 'on') add('network.warp', 'info', 'traffic leaves through Cloudflare WARP (shared egress)');

  // Only from real numbers: a missing or failed jobs section is not "nothing read".
  if (s.jobs?.read24h && daytime) {
    const evaluated24h = Object.values(s.jobs.read24h).reduce((sum, item) => sum + item.evaluated, 0);
    if (evaluated24h === 0) add('jobs.none_read', 'error', 'no job was evaluated in 24h');
  }

  const unknown = s.jobs?.read24h?.unknown;
  if (unknown?.newSuitable) add('jobs.unknown_source', 'info', `${unknown.newSuitable} suitable jobs in 24h have no recorded source (empty sources_json, no sighting)`);

  for (const finding of Array.isArray(s.health) ? s.health : []) add(`health.${finding.key.split(':')[0]}`, finding.severity === 'info' ? 'info' : 'warn', `${finding.key}: ${finding.title}`);

  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((left, right) => order[left.severity] - order[right.severity]);
}

export function formatPulseText(p) {
  const lines = [`jobOps pulse — ${p.local}`];
  const read = Object.entries(p.jobs?.read24h || {}).map(([kind, item]) => `${kind} ${item.evaluated} (${item.newSuitable} suitable)`).join(', ') || 'none';
  lines.push(`Jobs evaluated in 24h: ${read}; new suitable: ${p.jobs?.newSuitable24h ?? '?'}`);
  lines.push(`WhatsApp: collector ${p.collector?.status}, group messages 1h/6h/24h ${p.whatsapp?.groupMessagesLast1h}/${p.whatsapp?.groupMessagesLast6h}/${p.whatsapp?.groupMessagesLast24h}`);
  const li = p.linkedin || {};
  const fetched = (li.requests?.last24h || []).map((row) => `${row.kind} ${row.n}`).join(', ') || 'none';
  lines.push(`LinkedIn: requests in 24h ${fetched}${li.requestLogSince ? ` (log since ${li.requestLogSince})` : ''}; postings evaluated ${li.postingsEvaluated24h ?? '?'}; queue ${li.queue?.linkedin_deferred ?? 0}; cooldown ${li.cooldown ? `until ${li.cooldown.until}` : 'none'}`);
  lines.push(`ATS last run: ${p.ats?.errors ?? '?'} errors of ${p.ats?.companies ?? '?'} companies`);
  lines.push(`Codex 24h: ${p.codex?.calls24h ?? '?'} calls, ${p.codex?.failed24h ?? '?'} failed`);
  lines.push(p.signals.length ? 'Signals:' : 'Signals: none');
  for (const signal of p.signals) lines.push(`  [${signal.severity}] ${signal.key} — ${signal.evidence}`);
  return lines.join('\n');
}

async function detectEgress() {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5_000) });
    const fields = Object.fromEntries((await response.text()).split('\n').map((line) => line.split('=')));
    return { warp: fields.warp ?? null, gateway: fields.gateway ?? null };
  } catch {
    return { warp: null, gateway: null };
  }
}

async function main() {
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath, { readonly: true });
  try {
    const pulse = await collectPulse({
      store,
      config,
      launchctlText: run('launchctl', ['list']),
      powerLogText: run('pmset', ['-g', 'log'], { timeout: 20_000 }),
      batteryText: run('pmset', ['-g', 'batt']),
      egress: await detectEgress(),
      logs: { ats: tail(path.join(ROOT_DIR, 'logs', 'scheduled', 'ats.log')) },
    });
    console.log(process.argv.includes('--text') ? formatPulseText(pulse) : JSON.stringify(pulse, null, 2));
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`pulse failed: ${error.message}`); process.exitCode = 1; });
}
