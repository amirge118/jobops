import assert from 'node:assert/strict';
import test from 'node:test';

import { checkUrlLiveness } from '../scripts/liveness-browser.mjs';

function fakePage({ status, bodyText = '', mainApplyControls = [], frames = [] }) {
  let currentUrl = '';
  let call = 0;
  const mainFrame = {};
  return {
    async goto(url) { currentUrl = url; return { status: () => status }; },
    async waitForTimeout() {},
    url: () => currentUrl,
    async evaluate() {
      call += 1;
      return call === 1 ? bodyText : mainApplyControls;
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, ...frames],
  };
}

function fakeFrame(applyControls) {
  return { evaluate: async () => applyControls };
}

const longBody = `Senior Backend Engineer at Example. ${'Build distributed services. '.repeat(20)}`;

test('finds an apply control embedded in an iframe when the main frame has none', async () => {
  const page = fakePage({
    status: 200,
    bodyText: longBody,
    mainApplyControls: [],
    frames: [fakeFrame(['Apply Now'])],
  });

  const result = await checkUrlLiveness(page, 'https://example.com/careers/1');

  assert.equal(result.result, 'active');
  assert.equal(result.code, 'apply_control_visible');
});

test('a frame that cannot be read (cross-origin, detached) never fails the whole check', async () => {
  const brokenFrame = { async evaluate() { throw new Error('cannot access frame'); } };
  const page = fakePage({
    status: 200,
    bodyText: longBody,
    mainApplyControls: [],
    frames: [brokenFrame, fakeFrame(['Apply Now'])],
  });

  const result = await checkUrlLiveness(page, 'https://example.com/careers/1');

  assert.equal(result.result, 'active');
});

test('no apply control anywhere (main frame or iframes) stays uncertain', async () => {
  const page = fakePage({
    status: 200,
    bodyText: longBody,
    mainApplyControls: [],
    frames: [fakeFrame(['Learn more'])],
  });

  const result = await checkUrlLiveness(page, 'https://example.com/careers/1');

  assert.equal(result.result, 'uncertain');
  assert.equal(result.code, 'no_apply_control');
});
