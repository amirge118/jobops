import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { importWhatsAppLinks } from '../scripts/jobs/import-whatsapp-links.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

test('manual WhatsApp link import is bounded, canonical and idempotent', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-whatsapp-import-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const config = { sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'group-a@g.us' }] } } };
  const links = [
    'https://example.com/jobs/1?utm_source=whatsapp',
    'https://example.com/jobs/1?utm_source=duplicate',
    'not-a-url',
  ];

  const first = importWhatsAppLinks({ config, store, groupName: 'Group A', links, importedAt: 5_000 });
  const second = importWhatsAppLinks({ config, store, groupName: 'Group A', links, importedAt: 6_000 });

  assert.deepEqual(first, { group: 'Group A', input: 3, accepted: 1, queued: 1, duplicates: 1, rejected: 1 });
  assert.equal(second.queued, 0);
  assert.equal(second.duplicates, 2);
  const pending = store.listPendingWhatsAppMessages('group-a@g.us', { untilMs: 10_000 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, 'https://example.com/jobs/1');
  assert.doesNotMatch(pending[0].messageId, /example|group-a/);
});

test('manual WhatsApp link import rejects unknown groups and oversized payloads', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-whatsapp-import-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createJobStore(path.join(dir, 'jobs.db'));
  context.after(() => store.close());
  const config = { sources: { whatsapp: { groups: [] } } };

  assert.throws(() => importWhatsAppLinks({ config, store, groupName: 'Missing', links: [] }), /configured/);
  config.sources.whatsapp.groups.push({ name: 'Group A', jid: 'group-a@g.us' });
  assert.throws(() => importWhatsAppLinks({
    config, store, groupName: 'Group A', links: Array.from({ length: 5_001 }, () => 'https://example.com'),
  }), /5,000/);
});
