// Renders one careers page in a headless browser and reports what a person
// would see behind it: the final URL, the rendered HTML, every request the
// page made (many careers sites load their ATS through an API call that never
// appears as a link), and every link with its text. Read-only: it never
// submits, clicks, or stores anything.

import { normalizeCompanyUrl } from './company-registry.mjs';

const NAVIGATE_TIMEOUT_MS = 30_000;
const SETTLE_MS = 5_000;
const MAX_REQUESTS = 400;
const MAX_LINKS = 1_000;

export function createCareersPageDiscovery({ launchBrowser } = {}) {
  let browser = null;
  let newLivenessPage = null;

  async function ensureBrowser() {
    if (browser) return browser;
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
      ({ newLivenessPage } = await import('../liveness-browser.mjs'));
    } catch (error) {
      throw new Error(`careers discovery requires Playwright with Chromium: ${error.message}`);
    }
    browser = await (launchBrowser ? launchBrowser(chromium) : chromium.launch({ headless: true }));
    return browser;
  }

  async function discover(rawUrl) {
    const url = normalizeCompanyUrl(rawUrl, { keepQuery: true });
    const activeBrowser = await ensureBrowser();
    const page = await newLivenessPage(activeBrowser);
    const requests = [];
    page.on('request', (request) => {
      if (requests.length < MAX_REQUESTS) requests.push(request.url());
    });
    try {
      // domcontentloaded + a settle wait: "networkidle" never fires on pages
      // with analytics beacons, which would turn a readable page into a timeout.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      const links = await page.$$eval('a[href]', (anchors, max) => anchors.slice(0, max).map((anchor) => ({
        href: anchor.href,
        text: (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      })), MAX_LINKS);
      return { url: page.url(), html: await page.content(), requests, links };
    } finally {
      await page.close();
    }
  }

  async function close() {
    if (browser) await browser.close();
    browser = null;
  }

  return { discover, close };
}
