#!/usr/bin/env node

// Smart WhatsApp trigger, run every 30 minutes by launchd.
//
// The persistent Collector already stores group messages locally for free;
// only processing (page reads + Codex scoring) costs usage, and each Codex
// batch pays a fixed ~2.4k-token prompt. So this check spends no tokens: it
// counts how many *new jobs* the pending messages would create (unique job
// links not already in SQLite, excluding known non-job links) and starts the
// same local-backlog processing as the dashboard button only when
//   - at least `minNewJobs` new jobs are waiting (a well-filled batch), or
//   - the oldest new job has waited `maxWaitMinutes` (so nothing sits long).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import { canonicalizeJobUrl } from './core.mjs';
import { knownNonJobReason } from './fetch-page.mjs';
import { createJobStore } from './store.mjs';

export const DEFAULT_TRIGGER = Object.freeze({ minNewJobs: 10, maxWaitMinutes: 120, lookbackDays: 7 });

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

// Mirrors how the collector pipeline reads links out of a message.
export function messageJobUrls(text) {
  const urls = (String(text ?? '').match(URL_PATTERN) || []).map((url) => url.replace(/[.,;)\]]+$/, ''));
  return [...new Set(urls)];
}

export function triggerSettings(config) {
  const configured = config?.sources?.whatsapp?.trigger || {};
  const pick = (name) => {
    const value = Number(configured[name]);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRIGGER[name];
  };
  return { minNewJobs: pick('minNewJobs'), maxWaitMinutes: pick('maxWaitMinutes'), lookbackDays: pick('lookbackDays') };
}

// Read-only: nothing is marked, recorded, or fetched.
export function inspectWhatsAppBacklog({ config, store, now = Date.now() }) {
  const settings = triggerSettings(config);
  const sinceMs = now - settings.lookbackDays * 24 * 60 * 60 * 1000;
  const newJobs = new Map(); // canonical URL -> earliest message timestamp
  let pendingMessages = 0;
  for (const group of config.sources.whatsapp?.groups || []) {
    const messages = store.listPendingWhatsAppMessages(group.jid, { sinceMs, untilMs: now, limit: 5_000 });
    pendingMessages += messages.length;
    for (const message of messages) {
      for (const url of messageJobUrls(message.text)) {
        const canonical = canonicalizeJobUrl(url);
        if (!canonical || knownNonJobReason(url) || store.isKnownJobUrl(canonical)) continue;
        const seenAt = Number(message.timestamp) || now;
        newJobs.set(canonical, Math.min(newJobs.get(canonical) ?? Infinity, seenAt));
      }
    }
  }
  const oldestAt = newJobs.size ? Math.min(...newJobs.values()) : null;
  const waitedMinutes = oldestAt == null ? 0 : Math.floor((now - oldestAt) / 60_000);
  return { pendingMessages, newJobs: newJobs.size, oldestAt, waitedMinutes, settings };
}

export function shouldProcess({ newJobs, waitedMinutes, settings }) {
  if (newJobs >= settings.minNewJobs) return { run: true, reason: 'enough_jobs' };
  if (newJobs > 0 && waitedMinutes >= settings.maxWaitMinutes) return { run: true, reason: 'waited_too_long' };
  return { run: false, reason: newJobs === 0 ? 'nothing_new' : 'waiting_for_more' };
}

function runBacklogProcessing(rootDir, lookbackDays) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(rootDir, 'scripts', 'jobs.mjs'),
      '--whatsapp-backlog', '--days', String(lookbackDays), '--wait-for-lock', '10',
    ], { cwd: rootDir, stdio: 'inherit' });
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
}

export async function runWhatsAppTrigger({ now = Date.now(), run = runBacklogProcessing, log = console.log } = {}) {
  const config = loadJobsConfig();
  if (!config.sources.whatsapp?.enabled) {
    log('WhatsApp כבוי; אין מה לבדוק.');
    return { run: false, reason: 'disabled' };
  }
  const store = createJobStore(config.jobsDbPath);
  let state;
  let quota;
  try {
    state = inspectWhatsAppBacklog({ config, store, now });
    quota = store.getLlmQuota();
  } finally { store.close(); }
  let decision = shouldProcess(state);
  // Without Codex quota nothing could be scored; the backlog simply keeps.
  if (decision.run && quota.blockedUntil && quota.blockedUntil > now) decision = { run: false, reason: 'llm_quota_exhausted' };
  const stamp = new Date(now).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  log(`[${stamp}] WhatsApp: ${state.pendingMessages} הודעות ממתינות, ${state.newJobs} משרות חדשות` +
    `${state.newJobs ? `, הוותיקה ממתינה ${state.waitedMinutes} דק׳` : ''} → ${decision.run ? 'מעבד עכשיו' : 'ממתין'} (${decision.reason}).`);
  if (decision.run) await run(config.rootDir, state.settings.lookbackDays);
  return { ...decision, ...state };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runWhatsAppTrigger()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`בדיקת WhatsApp נכשלה: ${error.message}`);
      process.exit(1);
    });
}
