import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from '../scripts/jobs/store.mjs';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-personal-area-'));
  return createJobStore(path.join(dir, 'jobs.db'));
}

function sampleItem(overrides = {}) {
  return {
    keyword: 'Kubernetes',
    kind: 'experience_gap',
    importance: 'required',
    explanation: 'התפקיד דורש ניסיון בניהול קלאסטרים.',
    suggestion: 'להוסיף פרויקט רלוונטי אם קיים ניסיון אמיתי.',
    sourceCompany: 'Example',
    sourceTitle: 'Backend Engineer',
    sourceJobKey: 'job-1',
    ...overrides,
  };
}

test('personal improvements: add, list ordered, and remove', () => {
  const store = newStore();
  const first = store.addPersonalImprovement(sampleItem());
  assert.equal(first.created, true);
  assert.equal(first.item.keyword, 'Kubernetes');

  const second = store.addPersonalImprovement(sampleItem({ keyword: 'GraphQL', sourceJobKey: 'job-2' }));
  assert.equal(second.created, true);

  const items = store.listPersonalImprovements();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.keyword), ['Kubernetes', 'GraphQL']);

  const removed = store.removePersonalImprovement(first.item.id);
  assert.equal(removed, true);
  assert.equal(store.listPersonalImprovements().length, 1);

  store.close();
});

test('personal improvements: transferring the same gap twice does not duplicate it', () => {
  const store = newStore();
  const first = store.addPersonalImprovement(sampleItem());
  const again = store.addPersonalImprovement(sampleItem());

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(store.listPersonalImprovements().length, 1);

  store.close();
});

test('personal improvements: the same keyword from a different job is kept separate', () => {
  const store = newStore();
  store.addPersonalImprovement(sampleItem({ sourceJobKey: 'job-1' }));
  store.addPersonalImprovement(sampleItem({ sourceJobKey: 'job-2' }));

  assert.equal(store.listPersonalImprovements().length, 2);

  store.close();
});

test('personal improvements: reordering persists the new positions', () => {
  const store = newStore();
  const a = store.addPersonalImprovement(sampleItem({ keyword: 'A', sourceJobKey: 'job-a' })).item;
  const b = store.addPersonalImprovement(sampleItem({ keyword: 'B', sourceJobKey: 'job-b' })).item;
  const c = store.addPersonalImprovement(sampleItem({ keyword: 'C', sourceJobKey: 'job-c' })).item;

  const reordered = store.reorderPersonalImprovements([c.id, a.id, b.id]);
  assert.deepEqual(reordered.map((item) => item.keyword), ['C', 'A', 'B']);
  assert.deepEqual(store.listPersonalImprovements().map((item) => item.keyword), ['C', 'A', 'B']);

  store.close();
});

test('personal improvements: reordering rejects a set that does not match existing items', () => {
  const store = newStore();
  const a = store.addPersonalImprovement(sampleItem({ keyword: 'A', sourceJobKey: 'job-a' })).item;
  store.addPersonalImprovement(sampleItem({ keyword: 'B', sourceJobKey: 'job-b' }));

  assert.throws(() => store.reorderPersonalImprovements([a.id]), /orderedIds must include every existing item/);

  store.close();
});

test('personal improvements: rejects an item missing required text', () => {
  const store = newStore();
  assert.throws(
    () => store.addPersonalImprovement(sampleItem({ explanation: '   ' })),
    /keyword, explanation and suggestion are required/,
  );
  store.close();
});
