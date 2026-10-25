import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const helperImport = "import './helpers/stdout-safe-console.mjs';";

// scripts/jobs.mjs prints progress with console.log; on the test runner's
// stdout that can hang Node 22's parent runner (see the helper's comment).
test('every test file that imports scripts/jobs.mjs loads the stdout-safe console first', () => {
  const missing = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).filter((name) => {
    const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
    return /from '\.\.\/scripts\/jobs\.mjs'/.test(source) && source.split('\n')[0] !== helperImport;
  });
  assert.deepEqual(missing, []);
});

test('the stdout-safe console keeps console output off stdout but visible on stderr', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import ${JSON.stringify(path.join(testsDir, 'helpers', 'stdout-safe-console.mjs'))}; console.log('progress'); console.info('info');`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /progress\ninfo/);
});
