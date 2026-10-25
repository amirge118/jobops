import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocationFilter, buildTitleFilter } from '../scripts/scan.mjs';

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

test('a place named only in the title is filtered; the home region in either field still wins', () => {
  const passes = buildLocationFilter({
    always_allow: ['Israel', 'Tel Aviv'], allow: ['Israel', 'Tel Aviv', 'Remote'], block: ['Singapore', 'APAC', 'London'],
  });
  assert.equal(passes('', 'Senior Software Engineer - Engineering APAC Singapore'), false, 'empty location, place in title');
  assert.equal(passes('', 'Backend Engineer'), true, 'missing data is still not penalized');
  assert.equal(passes('Tel Aviv', 'Backend Engineer - APAC'), true, 'the home region in the location wins');
  assert.equal(passes('', 'Backend Engineer (Tel Aviv / London)'), true, 'the home region in the title wins');
  assert.equal(passes('London', 'Backend Engineer'), false, 'location-field rules are unchanged');
  assert.equal(passes('Remote', 'Backend Engineer'), true);
  assert.equal(passes('Berlin', 'Backend Engineer'), false, 'allow list still applies to a stated location');
});
