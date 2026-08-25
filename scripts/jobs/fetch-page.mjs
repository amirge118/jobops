import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

import { classifyLiveness } from '../liveness-core.mjs';
import { checkUrlLiveness, newLivenessPage } from '../liveness-browser.mjs';
import { canonicalizeJobUrl } from './core.mjs';

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

export function createJobPageFetcher({ store, cacheTtlMs }) {
  let browser = null;
  let page = null;

  async function renderedCheck(url) {
    try {
      if (!browser) browser = await chromium.launch({ headless: true });
      if (!page) page = await newLivenessPage(browser);
      const liveness = await checkUrlLiveness(page, url);
      const content = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      return { liveness, content: content.replace(/\s+/g, ' ').trim(), finalUrl: page.url() };
    } catch (error) {
      return {
        liveness: { result: 'uncertain', code: 'browser_error', reason: error.message.split('\n')[0] },
        content: '',
        finalUrl: url,
      };
    }
  }

  return {
    async fetch(url) {
      const canonicalUrl = canonicalizeJobUrl(url);
      if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);

      const cached = store.getFreshPage(canonicalUrl, { ttlMs: cacheTtlMs });
      if (cached) {
        return {
          canonicalUrl,
          finalUrl: cached.final_url,
          status: cached.status,
          content: cached.content,
          contentHash: cached.content_hash,
          fromCache: true,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let finalUrl = url;
      let content = '';
      let liveness;
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT },
        });
        finalUrl = response.url || url;
        const html = await response.text();
        content = htmlToText(html);
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
        reason: liveness.reason,
        fromCache: false,
      };
    },

    async close() {
      if (browser) await browser.close().catch(() => {});
      browser = null;
      page = null;
    },
  };
}
