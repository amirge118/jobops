import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function moduleFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) moduleFiles(full, found);
    else if (entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// `node --check` passes a call to a name nothing imports, and the failure shows
// only when that line runs: a removed import stopped every LinkedIn scan on
// 2026-11-01 while all tests stayed green. There is no linter here, so this
// catches that one case: calling something another module exports, unimported.
test('no module calls an export of another module without importing it', () => {
  const files = moduleFiles(path.join(ROOT, 'scripts'));
  const sources = new Map(files.map((file) => [file, withoutComments(fs.readFileSync(file, 'utf8'))]));
  const exported = new Set();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/^export\s+(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm)) exported.add(match[1]);
  }
  const lost = [];
  for (const [file, source] of sources) {
    for (const name of exported) {
      const word = name.replace(/\$/g, '\\$');
      const calls = source.match(new RegExp(`(?<![.\\w$])${word}\\s*\\(`, 'g'))?.length ?? 0;
      if (!calls) continue;
      // Any non-call mention (an import, a parameter) means it is in scope.
      const mentions = source.match(new RegExp(`(?<![.\\w$])${word}(?![\\w$])`, 'g')).length;
      const definedHere = new RegExp(`function\\*?\\s+${word}\\s*\\(|^\\s*(?:async\\s+)?${word}\\s*\\(.*\\)\\s*\\{\\s*$`, 'm').test(source);
      if (mentions === calls && !definedHere) lost.push(`${path.relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(lost, []);
});
