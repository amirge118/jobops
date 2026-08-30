import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('action output gives terminal QR codes a full-width readable surface', () => {
  const css = fs.readFileSync(path.join(rootDir, 'web', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(rootDir, 'web', 'app.js'), 'utf8');

  assert.match(css, /\.activity-card details\s*\{[^}]*flex-basis:\s*100%/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*white-space:\s*pre;/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*font-size:\s*1\.15rem;/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*max-height:\s*80vh;/s);
  assert.match(app, /if \(action\.status === 'running'\) elements\.activityDetails\.open = true;/);
  assert.match(app, /elements\.activityOutput\.scrollTop = elements\.activityOutput\.scrollHeight;/);
});

test('dashboard exposes a per-source and per-group processing funnel', () => {
  const html = fs.readFileSync(path.join(rootDir, 'web', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rootDir, 'web', 'app.js'), 'utf8');

  assert.match(html, /id="run-audit-body"/);
  assert.match(html, /id="retry-failed"/);
  assert.match(html, /id="mark-read"/);
  assert.match(html, />כיסוי</);
  assert.match(html, />הודעות \/ משרות</);
  assert.match(html, />קישורים</);
  assert.match(html, />תוצאת עיבוד הקישור</);
  assert.match(app, /function renderRunAudit\(lastRun\)/);
  assert.match(app, /מתאים.*notSuitable/s);
  assert.match(app, /כבר נבדקו/);
  assert.match(app, /incomplete: 'כיסוי חלקי'/);
  assert.match(app, /function runIsIncomplete\(lastRun\)/);
  assert.match(app, /runAction\('retry-failed'\)/);
  assert.match(app, /runAction\('mark-read'\)/);
  assert.match(app, /סומן כנקרא/);
  assert.match(app, /Boolean\(whatsapp\?\.warning\)/);
});
