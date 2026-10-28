// HireMeTech masks the employer and the apply link for anonymous visitors
// (`employer_masked: true`, `apply_url: null`), so every job read through its
// public API arrives as company "unknown" with a link back to HireMeTech. A
// signed-in browser profile (auth/hiremetech, created by
// `npm run jobs:hiremetech-login`) sees both. This module asks the API from
// inside that profile first; only when it is still masked does it press the
// one "apply" button and read the address of the company page that opens.
// It never clicks or types anything else: no application is ever sent, and
// HireMeTech's "did you apply?" prompt is left unanswered.

import fs from 'node:fs';
import path from 'node:path';

export const HIREMETECH_ORIGIN = 'https://hiremetech.com';
const APPLY_BUTTON_NAME = /הגש מועמדות|apply now|^apply$/i;
const NAVIGATION_TIMEOUT_MS = 30_000;
const POPUP_TIMEOUT_MS = 15_000;
const FOREIGN_BOARD_HOST = /(^|\.)(hiremetech\.com|linkedin\.com)$/i;
// An ATS API endpoint (e.g. comeet.co/careers-api/...?token=) is what the
// listing stores, not a page a person can open; the apply button leads to one.
const API_ENDPOINT_PATH = /\/(api|careers-api)\//i;

// A company page we can read and send the person to: http(s), and not
// HireMeTech itself or LinkedIn (both only lead back to a masked listing).
export function acceptableTarget(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (FOREIGN_BOARD_HOST.test(url.hostname)) return null;
  if (API_ENDPOINT_PATH.test(url.pathname)) return null;
  return url.href;
}

export function hireMeTechTarget(job) {
  const company = String(job?.company_name || job?.company?.name || '').trim() || null;
  const destination = typeof job?.applications_destination === 'string' ? job.applications_destination : null;
  return {
    company,
    targetUrl: acceptableTarget(job?.apply_url) || acceptableTarget(destination),
    masked: Boolean(job?.employer_masked) || !company,
  };
}

export function hireMeTechProfilePath(config) {
  const configured = config.sources?.hiremetech?.profilePath || 'auth/hiremetech';
  return path.resolve(config.rootDir, configured);
}

export function hireMeTechProfileExists(profilePath) {
  try { return fs.readdirSync(profilePath).length > 0; } catch { return false; }
}

// HireMeTech keeps the session as a bearer token in localStorage (no
// cookie), so the API is asked from a page on its own origin, the way the
// site itself asks it. The token never leaves that page.
export async function readApiJob(apiPage, jobId) {
  const answer = await apiPage.evaluate(async (id) => {
    const raw = localStorage.getItem('auth_token') || '';
    let token = raw;
    try { if (raw.startsWith('"')) token = JSON.parse(raw); } catch { token = raw; }
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { headers });
    return { signedIn: Boolean(token), status: response.status, payload: response.ok ? await response.json() : null };
  }, String(jobId));
  if (answer.status !== 200) throw new Error(`HireMeTech API returned HTTP ${answer.status}`);
  const job = answer.payload?.job;
  if (!job || typeof job !== 'object') throw new Error('HireMeTech API returned no job object');
  return { signedIn: answer.signedIn, job };
}

export async function openHireMeTechApiPage(context) {
  const page = await context.newPage();
  await page.goto(`${HIREMETECH_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  return page;
}

const notYetNavigated = (url) => !url || url === 'about:blank';

async function readPopupUrl(popup) {
  // A new tab reports '' or about:blank until its first navigation starts.
  if (notYetNavigated(popup.url())) {
    await popup.waitForURL((url) => !notYetNavigated(url.href), { timeout: POPUP_TIMEOUT_MS }).catch(() => {});
  }
  return popup.url();
}

async function clickApply(context, jobId) {
  const page = await context.newPage();
  try {
    // The button is wired only once the app has loaded; a click before that does nothing.
    await page.goto(`${HIREMETECH_ORIGIN}/job/${jobId}`, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => page.waitForLoadState('load').catch(() => {}));
    if (/\/(login|signin|sign-in|auth)\b/i.test(new URL(page.url()).pathname)) return { loggedIn: false, error: 'login_redirect' };
    const button = page.getByRole('button', { name: APPLY_BUTTON_NAME })
      .or(page.getByRole('link', { name: APPLY_BUTTON_NAME }))
      .first();
    await button.waitFor({ state: 'visible', timeout: POPUP_TIMEOUT_MS }).catch(() => {});
    if (!(await button.count())) return { loggedIn: true, error: 'no_apply_button' };

    const popupPromise = context.waitForEvent('page', { timeout: POPUP_TIMEOUT_MS }).catch(() => null);
    const before = page.url();
    await button.click();
    const popup = await popupPromise;
    let opened = null;
    if (popup) {
      try { opened = await readPopupUrl(popup); } finally { await popup.close().catch(() => {}); }
      if (notYetNavigated(opened)) opened = null;
    } else if (page.url() !== before) {
      opened = page.url();
    }
    const targetUrl = acceptableTarget(opened);
    // The session was already confirmed by the API, so a click that opened
    // nothing is this listing's problem, not a sign-out.
    if (!opened) return { loggedIn: true, error: 'no_popup' };
    return targetUrl ? { loggedIn: true, targetUrl } : { loggedIn: true, error: 'foreign_target' };
  } finally {
    await page.close().catch(() => {});
  }
}

export function createHireMeTechResolver({
  profilePath,
  launchContext,
  maxResolves = 15,
  delayMs = [4_000, 9_000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
}) {
  let context = null;
  let apiPage = null;
  let resolved = 0;
  let loggedOut = false;

  async function getContext() {
    if (!context) context = await launchContext(profilePath);
    if (!apiPage) apiPage = await openHireMeTechApiPage(context);
    return context;
  }

  return {
    get loggedOut() { return loggedOut; },
    get attempts() { return resolved; },

    // → { status, company, targetUrl, method, error }; status is one of
    // resolved | masked | failed (cached per job) or logged_out | unavailable |
    // skipped | budget (not cached: the next run tries the job again).
    async resolve(jobId) {
      if (loggedOut) return { status: 'skipped' };
      if (resolved >= maxResolves) return { status: 'budget' };
      if (resolved > 0) {
        const [low, high] = delayMs;
        await sleep(low + Math.floor(random() * Math.max(0, high - low)));
      }
      resolved += 1;
      let ctx;
      try {
        ctx = await getContext();
      } catch (error) {
        // The profile is unusable this run (e.g. the login window holds its
        // lock): not the job's fault, so nothing is cached and none retried.
        loggedOut = true;
        return { status: 'unavailable', error: String(error?.message || error).split('\n')[0].slice(0, 200) };
      }
      try {
        const { signedIn, job } = await readApiJob(apiPage, jobId);
        if (!signedIn) {
          loggedOut = true;
          return { status: 'logged_out', error: 'no_session_token' };
        }
        const fromApi = hireMeTechTarget(job);
        if (fromApi.targetUrl && fromApi.company) {
          return { status: 'resolved', method: 'api', company: fromApi.company, targetUrl: fromApi.targetUrl };
        }
        const clicked = await clickApply(ctx, jobId);
        if (!clicked.loggedIn) {
          loggedOut = true;
          return { status: 'logged_out', error: clicked.error };
        }
        if (!clicked.targetUrl) return { status: 'masked', company: fromApi.company, error: clicked.error };
        return { status: 'resolved', method: 'click', company: fromApi.company, targetUrl: clicked.targetUrl };
      } catch (error) {
        return { status: 'failed', error: String(error?.message || error).split('\n')[0].slice(0, 200) };
      }
    },

    async close() {
      if (context) await context.close().catch(() => {});
      context = null;
      apiPage = null;
    },
  };
}

// The installed Google Chrome (still with its own profile directory, not the
// person's): Google sign-in refuses Playwright's bundled Chromium and any
// browser announcing automation. Falls back to the bundled one when Chrome
// is missing. Login and scans must use the same browser for one profile.
export async function launchHireMeTechContext(profilePath, { headless = true, chromiumImpl } = {}) {
  const chromium = chromiumImpl || (await import('playwright')).chromium;
  fs.mkdirSync(profilePath, { recursive: true });
  const options = { headless, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] };
  try {
    return await chromium.launchPersistentContext(profilePath, { ...options, channel: 'chrome' });
  } catch (error) {
    if (!/channel|executable|not found|install/i.test(String(error?.message))) throw error;
    const { LIVENESS_CONTEXT_OPTIONS } = await import('../liveness-browser.mjs');
    return chromium.launchPersistentContext(profilePath, { ...options, ...LIVENESS_CONTEXT_OPTIONS });
  }
}
