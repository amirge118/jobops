import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPageWithBrowser } from '../scripts/jobs/browser-fetch.mjs';

function fakeBrowser({ finalUrl, html }) {
  const calls = [];
  return {
    calls,
    async newContext(options) {
      calls.push({ step: 'newContext', options });
      return {
        async newPage() {
          calls.push({ step: 'newPage' });
          return {
            async goto(url, options) { calls.push({ step: 'goto', url, options }); },
            async content() { return html; },
            url() { return finalUrl; },
          };
        },
      };
    },
    async close() { calls.push({ step: 'close' }); },
  };
}

test('renders a page with an injected browser and returns its post-JS HTML', async () => {
  const browser = fakeBrowser({ finalUrl: 'https://example.com/careers', html: '<h1>Careers</h1>' });
  const page = await fetchPageWithBrowser('https://example.com/careers', {
    launchBrowser: async () => browser,
  });

  assert.deepEqual(page, { url: 'https://example.com/careers', html: '<h1>Careers</h1>' });
  assert.equal(browser.calls.some((call) => call.step === 'goto' && call.url === 'https://example.com/careers'), true);
  assert.equal(browser.calls.at(-1).step, 'close');
});

test('closes the browser even when navigation fails', async () => {
  const browser = fakeBrowser({ finalUrl: '', html: '' });
  browser.newContext = async () => ({
    async newPage() {
      return { async goto() { throw new Error('boom'); }, async content() { return ''; }, url() { return ''; } };
    },
  });
  await assert.rejects(
    fetchPageWithBrowser('https://example.com/careers', { launchBrowser: async () => browser }),
    /boom/,
  );
  assert.equal(browser.calls.at(-1).step, 'close');
});

test('rejects a private or non-HTTPS URL before ever launching a browser', async () => {
  let launched = false;
  await assert.rejects(
    fetchPageWithBrowser('http://127.0.0.1/careers', { launchBrowser: async () => { launched = true; } }),
    /unsafe|HTTPS|hostname/i,
  );
  assert.equal(launched, false);
});
