import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDemoEnvironment } from '../scripts/jobs/demo.mjs';
import { inspectProject } from '../scripts/doctor.mjs';
import { setupProject } from '../scripts/setup.mjs';

test('demo mode uses isolated synthetic data and exposes scan health', (context) => {
  const demo = createDemoEnvironment({ rootDir: '/project', now: 1_800_000_000_000 });
  context.after(() => demo.cleanup());

  assert.match(demo.config.jobsDbPath, /jobops-demo-/);
  assert.equal(demo.config.demo, true);
  assert.equal(demo.config.sources.whatsapp.groups.length, 4);

  const snapshot = demo.store.getDashboardSnapshot();
  assert.equal(snapshot.jobs.length, 4);
  assert.equal(snapshot.stats.suitable, 4);
  assert.equal(snapshot.lastRun.status, 'success');
  assert.equal(snapshot.lastRun.details.whatsapp.groups.length, 4);
  assert.deepEqual(snapshot.jobs[0].fitBreakdown.uncertainties, ['אין ניסיון מפורש ב-Go; זו אינה דרישת חסימה.']);
  assert.equal(snapshot.jobs.every((job) => job.applyUrl.startsWith('https://example.com/')), true);
  demo.store.close();
});

test('setup creates private files from templates and never overwrites them', (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-setup-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'config', 'jobs.example.yml'), 'scan: example\n');
  fs.writeFileSync(path.join(rootDir, 'templates', 'candidate-profile.example.md'), 'candidate template\n');
  fs.writeFileSync(path.join(rootDir, 'templates', 'preferences.example.md'), 'preferences template\n');

  const first = setupProject({ rootDir });
  assert.equal(first.created.length, 3);
  assert.equal(first.directories.includes('auth'), true);
  assert.equal(first.directories.includes('output'), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'output')), false);
  fs.writeFileSync(path.join(rootDir, 'profile', '01-candidate-profile.md'), 'my profile\n');

  const second = setupProject({ rootDir });
  assert.equal(second.created.length, 0);
  assert.equal(fs.readFileSync(path.join(rootDir, 'profile', '01-candidate-profile.md'), 'utf8'), 'my profile\n');
});

test('doctor reports actionable readiness without exposing WhatsApp identifiers', () => {
  const checks = inspectProject({
    rootDir: '/project',
    nodeVersion: '22.12.0',
    fileExists(filePath) {
      return new Set([
        '/project/config/jobs.yml',
        '/project/profile/01-candidate-profile.md',
        '/project/profile/02-preferences.md',
        '/project/auth/creds.json',
        '/project/.gitignore',
      ]).has(filePath);
    },
    readText(filePath) {
      if (filePath.endsWith('.gitignore')) return 'auth/\nprofile/\ndata/\nreports/\n.env\n';
      if (filePath.endsWith('jobs.yml')) return `sources:\n  whatsapp:\n    enabled: true\n    groups:\n      - name: Group A\n        jid: 123@g.us\n`;
      return '';
    },
    commandStatus(command) {
      if (command === 'codex') return { ok: true, detail: 'מחובר באמצעות ChatGPT' };
      if (command === 'chrome') return { ok: true, detail: 'Google Chrome זמין' };
      return { ok: false, detail: 'לא זמין' };
    },
  });

  assert.equal(checks.every((check) => check.status !== 'fail'), true);
  assert.equal(checks.some((check) => check.label === 'WhatsApp' && /1 קבוצות/.test(check.detail)), true);
  assert.doesNotMatch(JSON.stringify(checks), /123@g\.us/);
});
