import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium } from 'playwright';
import { resolveCodexBinary } from '../jobs/score-job.mjs';
import { createJobStore } from '../jobs/store.mjs';
import { rateLimitBlockedUntil, readCodexRateLimits } from '../jobs/llm-usage.mjs';

function defaultQuotaState(config) {
  if (!config?.jobsDbPath) return null;
  const store = createJobStore(config.jobsDbPath);
  let stored;
  try { stored = store.getLlmQuota(); }
  finally { store.close(); }
  // Free: Codex's own local record of the account's usage windows.
  let limitedUntil = null;
  try { limitedUntil = rateLimitBlockedUntil(readCodexRateLimits({ fsModule: fs })); } catch { limitedUntil = null; }
  return { ...stored, blockedUntil: Math.max(Number(stored?.blockedUntil) || 0, Number(limitedUntil) || 0) || null };
}

const SANDBOX_REASON = 'האתר הופעל מתוך סביבת Codex מוגבלת, ולכן תהליכי Chromium ומנגנון הציון אינם יכולים לפעול.';
const SANDBOX_STEP = 'סגור את השרת הנוכחי והפעל את start-jobops.command מ-Finder או את npm run start:local מתוך Terminal רגיל.';

function ready(label) {
  return { status: 'ready', code: null, label, reason: null, nextStep: null };
}

function blocked(code, label, reason, nextStep) {
  return { status: 'blocked', code, label, reason, nextStep };
}

const execFileAsync = promisify(execFile);

async function defaultCodexProbe(config) {
  await fs.promises.access(path.join(os.homedir(), '.codex'), fs.constants.R_OK | fs.constants.W_OK);
  const binary = resolveCodexBinary(config || { scoring: {} });
  const result = await execFileAsync(binary, ['login', 'status'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (!/Logged in using ChatGPT/i.test(output)) {
    const error = new Error('Codex is not logged in with ChatGPT.');
    error.readinessCode = 'scorer_not_logged_in';
    throw error;
  }
}

async function defaultBrowserProbe() {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

export async function inspectRuntimeReadiness({
  config,
  collector = null,
  env = process.env,
  probeBrowser = defaultBrowserProbe,
  probeCodexState = defaultCodexProbe,
  readQuota = defaultQuotaState,
  now = Date.now(),
} = {}) {
  if (config?.demo) {
    return {
      checkedAt: now,
      browser: ready('דפדפן אוטומטי'),
      scorer: ready('מנגנון התאמה'),
      collector: ready('WhatsApp Collector'),
      readyFor: { ats: true, whatsapp: true },
    };
  }

  const sandboxed = Boolean(env.CODEX_SANDBOX || env.CODEX_PERMISSION_PROFILE);
  let browser;
  let scorer;
  if (sandboxed) {
    browser = blocked('sandboxed_runtime', 'דפדפן אוטומטי', SANDBOX_REASON, SANDBOX_STEP);
    scorer = blocked('sandboxed_runtime', 'מנגנון התאמה', SANDBOX_REASON, SANDBOX_STEP);
  } else {
    try {
      await probeCodexState(config);
      let quota = null;
      try { quota = readQuota(config); } catch { quota = null; }
      scorer = quota?.blockedUntil && quota.blockedUntil > now
        ? blocked(
          'llm_quota_exhausted',
          'מנגנון התאמה',
          `מכסת Codex נגמרה ותתחדש בערך ב-${new Date(quota.blockedUntil).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}. סריקות מדולגות עד אז.`,
          'אין צורך בפעולה: הסריקות המתוזמנות ימשיכו לבד כשהמכסה תתחדש.',
        )
        : ready('מנגנון התאמה');
    } catch (error) {
      scorer = error?.readinessCode === 'scorer_not_logged_in'
        ? blocked(
          'scorer_not_logged_in',
          'מנגנון התאמה',
          'Codex אינו מחובר כרגע באמצעות חשבון ChatGPT.',
          'הפעל codex login מתוך Terminal רגיל, התחבר באמצעות ChatGPT ובדוק שוב.',
        )
        : blocked(
          'scorer_permission_denied',
          'מנגנון התאמה',
          'לתהליך אין הרשאת קריאה וכתיבה לתיקיית ההתחברות המקומית של Codex.',
          'הפעל את האתר מתוך Terminal רגיל וודא של-Terminal יש הרשאה לתיקיית המשתמש.',
        );
    }
    try {
      await probeBrowser();
      browser = ready('דפדפן אוטומטי');
    } catch {
      browser = blocked(
        'browser_unavailable',
        'דפדפן אוטומטי',
        'Chromium לא הצליח לעלות, ולכן חלק מעמודי המשרות אינם ניתנים לקריאה.',
        'הפעל npx playwright install chromium מתוך Terminal רגיל ונסה שוב.',
      );
    }
  }

  const collectorReady = collector?.status === 'connected';
  const collectorState = collectorReady
    ? ready('WhatsApp Collector')
    : blocked(
      'collector_offline',
      'WhatsApp Collector',
      collector?.diagnostic?.reason || 'ה-Collector אינו מחובר ולכן אין כיסוי אמין להודעות WhatsApp חדשות.',
      'הפעל פעם אחת npm run whatsapp:collector:install מתוך Terminal רגיל והמתן למצב מחובר.',
    );
  const runtimeReady = browser.status === 'ready' && scorer.status === 'ready';

  return {
    checkedAt: now,
    browser,
    scorer,
    collector: collectorState,
    // LinkedIn postings are read over plain HTTP, so only scoring is required.
    readyFor: { ats: runtimeReady, whatsapp: runtimeReady && collectorReady, linkedin: scorer.status === 'ready' },
  };
}

export function blockersForAction(readiness, action, options = {}) {
  if (!['scan', 'retry-failed', 'process-backlog'].includes(action)) return [];
  const components = action === 'scan' && options.source === 'linkedin'
    ? [readiness?.scorer]
    : [readiness?.browser, readiness?.scorer];
  if (action === 'scan' && ['all', 'whatsapp'].includes(options.source)) components.push(readiness?.collector);
  const unique = new Map();
  for (const component of components) {
    if (component?.status === 'blocked' && !unique.has(component.code)) unique.set(component.code, component);
  }
  return [...unique.values()];
}

export function createReadinessService(config, getCollector, {
  inspect = inspectRuntimeReadiness,
  ttlMs = 60_000,
} = {}) {
  let cached = null;
  let pending = null;
  return {
    async inspect({ force = false } = {}) {
      if (!force && cached && Date.now() - cached.checkedAt < ttlMs) return cached;
      if (pending) return pending;
      pending = Promise.resolve(inspect({ config, collector: getCollector() }))
        .then((result) => { cached = result; return result; })
        .finally(() => { pending = null; });
      return pending;
    },
  };
}
