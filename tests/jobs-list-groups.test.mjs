import test from 'node:test';
import assert from 'node:assert/strict';

import { formatGroupLine, summarizeGroups } from '../scripts/jobs/list-groups.mjs';

const participating = {
  'a@g.us': { id: 'a@g.us', subject: 'Secret Backend Job', participants: [{}, {}] },
  'b@g.us': { id: 'b@g.us', subject: 'משרות טק: מנוסים 2', participants: [{}] },
  'c@g.us': { id: 'c@g.us' },
};

test('configured groups are marked and listed first', () => {
  const groups = summarizeGroups(participating, [{ name: 'x', jid: 'b@g.us' }]);
  assert.equal(groups[0].jid, 'b@g.us');
  assert.equal(groups[0].configured, true);
  assert.deepEqual(groups.filter((group) => group.configured).map((group) => group.jid), ['b@g.us']);
});

test('filter matches subject case-insensitively or jid', () => {
  assert.deepEqual(summarizeGroups(participating, [], { filter: 'backend' }).map((group) => group.jid), ['a@g.us']);
  assert.deepEqual(summarizeGroups(participating, [], { filter: 'c@g' }).map((group) => group.jid), ['c@g.us']);
});

test('groups without subject or participants still format', () => {
  const [group] = summarizeGroups(participating, [], { filter: 'c@g' });
  assert.equal(group.subject, '');
  assert.equal(group.participants, null);
  assert.equal(formatGroupLine(group), '  (ללא שם) — c@g.us');
  assert.equal(formatGroupLine({ jid: 'a@g.us', subject: 'S', participants: 2, configured: true }), '✓ S — a@g.us · 2 חברים');
});
