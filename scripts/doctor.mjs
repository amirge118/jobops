#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { ROOT_DIR } from './jobs/config.mjs';
import { resolveCodexBinary } from './jobs/score-job.mjs';

function defaultCommandStatus(command) {
  if (command === 'chrome') {
    const available = process.platform !== 'darwin' || fs.existsSync('/Applications/Google Chrome.app');
    return { ok: available, detail: available ? 'Google Chrome זמין' : 'Google Chrome לא נמצא ב-Applications' };
  }
  const binary = resolveCodexBinary({ scoring: {} });
  const result = spawnSync(binary, ['login', 'status'], { encoding: 'utf8', timeout: 10_000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const ok = result.status === 0 && /Logged in using ChatGPT/i.test(output);
  return { ok, detail: ok ? 'מחובר באמצעות ChatGPT' : 'נדרשת התחברות: codex login' };
}

export function inspectProject({
  rootDir = ROOT_DIR,
  nodeVersion = process.versions.node,
  fileExists = fs.existsSync,
  readText = (filePath) => fs.readFileSync(filePath, 'utf8'),
  commandStatus = defaultCommandStatus,
} = {}) {
  const checks = [];
  const major = Number(String(nodeVersion).split('.')[0]);
  checks.push({ label: 'Node.js', status: major >= 22 ? 'pass' : 'fail', detail: `גרסה ${nodeVersion}; נדרשת 22 ומעלה` });

  const requiredFiles = [
    ['Config', 'config/jobs.yml'],
    ['פרופיל מועמד', 'profile/01-candidate-profile.md'],
    ['העדפות', 'profile/02-preferences.md'],
  ];
  for (const [label, relativePath] of requiredFiles) {
    const exists = fileExists(path.join(rootDir, relativePath));
    checks.push({ label, status: exists ? 'pass' : 'fail', detail: exists ? `${relativePath} קיים` : `${relativePath} חסר; הרץ npm run setup` });
  }

  const ignorePath = path.join(rootDir, '.gitignore');
  const ignoreText = fileExists(ignorePath) ? readText(ignorePath) : '';
  const privatePatterns = ['auth/', 'profile/', 'data/', 'reports/', '.env'];
  const missingPatterns = privatePatterns.filter((pattern) => !ignoreText.split(/\r?\n/).includes(pattern));
  checks.push({
    label: 'פרטיות Git',
    status: missingPatterns.length === 0 ? 'pass' : 'fail',
    detail: missingPatterns.length === 0 ? 'קבצים פרטיים מוחרגים' : `חסרות החרגות: ${missingPatterns.join(', ')}`,
  });

  const configPath = path.join(rootDir, 'config/jobs.yml');
  if (fileExists(configPath)) {
    try {
      const config = loadYaml(readText(configPath));
      const whatsapp = config?.sources?.whatsapp;
      if (whatsapp?.enabled) {
        const groupCount = Array.isArray(whatsapp.groups) ? whatsapp.groups.length : 0;
        const paired = fileExists(path.join(rootDir, whatsapp.authPath || 'auth', 'creds.json'));
        checks.push({
          label: 'WhatsApp',
          status: groupCount > 0 && paired ? 'pass' : 'warn',
          detail: `${groupCount} קבוצות מוגדרות; ${paired ? 'המכשיר מקושר' : 'נדרש קישור מכשיר בריצה הראשונה'}`,
        });
      } else {
        checks.push({ label: 'WhatsApp', status: 'warn', detail: 'המקור כבוי ב-config/jobs.yml' });
      }
    } catch {
      checks.push({ label: 'WhatsApp', status: 'fail', detail: 'config/jobs.yml אינו YAML תקין' });
    }
  }

  for (const command of ['codex', 'chrome']) {
    const result = commandStatus(command);
    checks.push({ label: command === 'codex' ? 'Codex' : 'Chrome', status: result.ok ? 'pass' : 'fail', detail: result.detail });
  }
  return checks;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const checks = inspectProject();
  const icons = { pass: '✓', warn: '!', fail: '✗' };
  for (const check of checks) console.log(`${icons[check.status]} ${check.label}: ${check.detail}`);
  const failures = checks.filter((check) => check.status === 'fail').length;
  console.log(failures ? `\nנמצאו ${failures} בעיות שחוסמות ריצה.` : '\nהמערכת מוכנה לריצה.');
  process.exitCode = failures ? 1 : 0;
}
