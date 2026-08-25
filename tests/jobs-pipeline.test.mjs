import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendMatchingJobs } from '../scripts/jobs/pipeline.mjs';

test('appendMatchingJobs writes under the English Pending section and deduplicates canonical URLs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-pipeline-'));
  const pipelinePath = path.join(dir, 'pipeline.md');
  fs.writeFileSync(pipelinePath, '# Pipeline\n\n## Pending\n\n## Done\n', 'utf8');

  const job = {
    company: 'Lemonade',
    title: 'Backend Engineer',
    score: 4.4,
    applyUrl: 'https://example.com/jobs/42?utm_source=whatsapp',
  };

  assert.equal(appendMatchingJobs(pipelinePath, [job]).added, 1);
  assert.equal(appendMatchingJobs(pipelinePath, [{ ...job, applyUrl: 'https://example.com/jobs/42?utm_source=linkedin' }]).added, 0);

  const content = fs.readFileSync(pipelinePath, 'utf8');
  assert.match(content, /## Pending\n- \[ \] https:\/\/example\.com\/jobs\/42\?utm_source=whatsapp/);
  assert.equal((content.match(/Lemonade/g) || []).length, 1);
  assert.doesNotMatch(content, /## Pendientes/);
});

test('appendMatchingJobs initializes a fresh private pipeline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-pipeline-fresh-'));
  const pipelinePath = path.join(root, 'data', 'pipeline.md');

  assert.equal(appendMatchingJobs(pipelinePath, []).added, 0);
  assert.match(fs.readFileSync(pipelinePath, 'utf8'), /## Pending[\s\S]*## Done/);
});
