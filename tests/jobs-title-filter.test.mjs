import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTitleFilter } from '../scripts/scan.mjs';

test('title filter keeps positives, drops negatives, and lets always_allow override a negative', () => {
  const keep = buildTitleFilter({
    positive: ['Backend', 'AI Engineer', 'Staff Engineer'],
    negative: ['Full Stack', 'Junior'],
    always_allow: ['Backend Oriented'],
  });
  assert.equal(keep('Senior Backend Engineer'), true);
  assert.equal(keep('Senior AI Engineer'), true);
  assert.equal(keep('Staff Engineer, Core Engineering'), true);
  assert.equal(keep('Senior Full Stack Developer'), false);
  assert.equal(keep('Junior Backend Engineer'), false);
  assert.equal(keep('Senior Full Stack Developer (Backend Oriented)'), true);
  assert.equal(keep('Product Designer'), false);
});

test('title filter without always_allow behaves as before', () => {
  const keep = buildTitleFilter({ positive: ['Backend'], negative: ['Full Stack'] });
  assert.equal(keep('Full Stack Backend Engineer'), false);
  assert.equal(buildTitleFilter({ always_allow: 'Backend Oriented' })('Anything'), true, 'empty positive list keeps everything');
});
