import { normalizeCompanyUrl } from './company-registry.mjs';

const NAVIGATE_TIMEOUT_MS = 25_000;

/**
 * Render a careers page with a real headless browser and return its
 * post-JavaScript HTML, in the same `{ url, html }` shape as
 * fetchPublicHtml (company-source-resolver.mjs) — so it can be dropped in
 * as that resolver's `fetchPage` and reuse its entire existing discovery
 * pipeline (known-ATS link scan, Comeet widget extraction, embedded-json
 * fallback) unchanged, just against a JS-rendered page instead of a plain
 * fetch response.
 *
 * This is the explicit, user-triggered last resort — see
 * POST /api/companies/:id/browser-probe in web.mjs — for the two cases a
 * plain fetch cannot get past: a bot-protection CDN that only serves real
 * browsers, and a client-side-rendered page with no server HTML at all.
 * It is never run automatically: a full browser render is far slower than
 * every other discovery step (seconds, not milliseconds) and can itself
 * be blocked by the same anti-bot defenses.
 */
export async function fetchPageWithBrowser(rawUrl, { timeoutMs = NAVIGATE_TIMEOUT_MS, launchBrowser } = {}) {
  const url = normalizeCompanyUrl(rawUrl, { keepQuery: true });
  let chromium;
  let newLivenessPage;
  try {
    ({ chromium } = await import('playwright'));
    ({ newLivenessPage } = await import('../liveness-browser.mjs'));
  } catch (error) {
    throw new Error(
      `browser probe requires Playwright with Chromium (run "npx playwright install chromium"): ${error.message}`,
    );
  }
  const browser = await (launchBrowser ? launchBrowser(chromium) : chromium.launch({ headless: true }));
  try {
    // newLivenessPage presents a realistic desktop Chrome UA — the same trick
    // that already clears common Cloudflare-style WAF challenges for the
    // --verify liveness checker, reused here for the same reason.
    const page = await newLivenessPage(browser);
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const html = await page.content();
    return { url: page.url(), html };
  } finally {
    await browser.close();
  }
}
