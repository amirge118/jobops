import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfiguredCompanyEntries, syncConfiguredCompanyEntries } from '../scripts/jobs/company-catalog.mjs';

test('company catalogue loads tracked companies and treats a missing file as empty', (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-company-catalog-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, 'portals.yml'), `tracked_companies:\n  - name: Example\n    careers_url: https://jobs.lever.co/example\n    enabled: true\n`);

  assert.equal(loadConfiguredCompanyEntries(rootDir).length, 1);
  assert.deepEqual(loadConfiguredCompanyEntries(rootDir, 'missing.yml'), []);
});

test('catalogue sync delegates to the store without making the file authoritative', (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-company-sync-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, 'portals.yml'), `tracked_companies:\n  - name: Example\n    careers_url: https://jobs.lever.co/example\n`);
  const calls = [];
  const result = syncConfiguredCompanyEntries({
    importConfiguredCompanies(entries) {
      calls.push(entries);
      return { imported: entries.length };
    },
  }, rootDir);

  assert.equal(calls[0][0].name, 'Example');
  assert.deepEqual(result, { imported: 1 });
});
