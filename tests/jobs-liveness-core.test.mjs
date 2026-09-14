import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLiveness } from '../scripts/liveness-core.mjs';

const longBody = `Senior Backend Engineer at Example. ${'Build distributed services. '.repeat(20)}`;

test('recognizes Hebrew apply controls as a live posting', () => {
  for (const control of ['הגש מועמדות', 'הגשי מועמדות', 'הגשת מועמדות', 'שלח קורות חיים', 'שלחי קורות חיים', 'שלח מועמדות']) {
    const result = classifyLiveness({ status: 200, finalUrl: 'https://example.co.il/careers/1', bodyText: longBody, applyControls: [control] });
    assert.equal(result.result, 'active', `expected "${control}" to be recognized as an apply control`);
    assert.equal(result.code, 'apply_control_visible');
  }
});

test('a Hebrew-only apply control phrase embedded in a longer label still matches', () => {
  const result = classifyLiveness({
    status: 200, finalUrl: 'https://example.co.il/careers/1', bodyText: longBody,
    applyControls: ['לחצו כאן להגשת מועמדות למשרה'],
  });
  assert.equal(result.result, 'active');
});

test('content with no recognized apply control (Hebrew or otherwise) stays uncertain, not expired', () => {
  const result = classifyLiveness({ status: 200, finalUrl: 'https://example.co.il/careers/1', bodyText: longBody, applyControls: ['קרא עוד'] });
  assert.equal(result.result, 'uncertain');
  assert.equal(result.code, 'no_apply_control');
});
