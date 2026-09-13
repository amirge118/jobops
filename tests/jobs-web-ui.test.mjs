import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAndArchiveJob } from '../web/shared/job-actions.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWeb = (...parts) => fs.readFileSync(path.join(rootDir, 'web', ...parts), 'utf8');

test('scan page exposes readiness and one automatic latest-result diagnosis', () => {
  const html = readWeb('scan.html');
  const app = readWeb('pages', 'scan-page.js');

  assert.match(html, /id="scan-form"/);
  assert.match(html, /id="retry-failed"/);
  assert.match(html, /id="mark-read"/);
  assert.match(html, /id="readiness-panel"/);
  assert.match(html, /id="scan-result-panel"/);
  assert.match(html, /id="diagnosis-issues"/);
  assert.match(html, /id="run-audit-body"/);
  assert.match(html, /id="backlog-total"/);
  assert.match(html, /id="request-history"/);
  assert.match(html, /השלם פערים מהיסטוריית WhatsApp/);
  assert.doesNotMatch(html, /id="diagnostics-history"/);
  assert.doesNotMatch(html, /היסטוריה מקומית/);
  assert.match(app, /function renderReadiness\(nextReadiness\)/);
  assert.match(app, /function renderDiagnosis\(diagnosis, lastRun\)/);
  assert.match(app, /function renderRunAudit\(lastRun\)/);
  assert.match(app, /function renderWhatsAppHistory\(history\)/);
  assert.match(app, /runAction\('process-backlog', \{ days: 7 \}\)/);
  assert.match(app, /lastCollectedAt/);
  assert.match(app, /runAction\('retry-failed'\)/);
  assert.match(app, /runAction\('mark-read'\)/);
  assert.doesNotMatch(app, /diagnostics\/history/);
});

test('action output gives terminal QR codes a full-width readable surface', () => {
  const css = readWeb('styles.css');
  const app = readWeb('pages', 'scan-page.js');

  assert.match(css, /\.activity-card details\s*\{[^}]*flex-basis:\s*100%/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*white-space:\s*pre;/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*font-size:\s*1\.15rem;/s);
  assert.match(css, /\.activity-card pre\s*\{[^}]*max-height:\s*80vh;/s);
  assert.match(app, /elements\.activityDetails\.open = true;/);
  assert.match(app, /elements\.activityOutput\.scrollTop = elements\.activityOutput\.scrollHeight/);
});

test('dashboard keeps readiness and source details compact', () => {
  const html = readWeb('scan.html');
  const css = readWeb('styles.css');
  const app = readWeb('pages', 'scan-page.js');

  assert.match(html, /id="source-details" class="source-details"/);
  assert.match(html, /id="technical-details" class="technical-details"/);
  assert.match(css, /\.summary-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.summary-grid article\s*\{[^}]*min-height:\s*84px/s);
  assert.match(css, /\.readiness-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.source-details\[hidden\]/);
  assert.match(app, /elements\.sourceDetails\.hidden = rows\.length === 0/);
  assert.match(app, /elements\.activity\.hidden = !actionRunning/);
});

test('decisions and companies keep explicit user-controlled actions', () => {
  const decisions = readWeb('pages', 'decisions-page.js');
  const companies = readWeb('pages', 'companies-page.js');

  assert.match(decisions, /בדוק חברה למעקב/);
  assert.match(decisions, /openAndArchiveJob\(job, archiveJob\)/);
  assert.match(companies, /אשר והוסף למעקב/);
  assert.match(companies, /נדרש אישור לפני הוספה למעקב/);
  assert.match(companies, /\/api\/companies\/research/);
  assert.match(companies, /data-status-filter/);
  assert.match(companies, /statusOrder/);
  assert.match(companies, /עדיין אין לסורק מתאם/);
});

test('a blocked popup does not archive the job', async () => {
  let archived = false;
  await assert.rejects(
    openAndArchiveJob(
      { jobKey: 'job', applyUrl: 'https://jobs.example.com/42' },
      async () => { archived = true; },
      () => null,
    ),
    /לא הועברה לארכיון/,
  );
  assert.equal(archived, false);
});

test('open plus archive navigates only after the archive succeeds', async () => {
  const events = [];
  const tab = { opener: {}, location: { replace: (url) => events.push(`open:${url}`) }, close: () => events.push('close') };
  await openAndArchiveJob(
    { jobKey: 'job', applyUrl: 'https://jobs.example.com/42' },
    async () => { events.push('archive'); },
    () => tab,
  );
  assert.deepEqual(events, ['archive', 'open:https://jobs.example.com/42']);
  assert.equal(tab.opener, null);
});

test('each dashboard page owns only its feature and shares the navigation shell', () => {
  const scan = readWeb('scan.html');
  const decisions = readWeb('decisions.html');
  const companies = readWeb('companies.html');

  assert.match(scan, /data-page="scan"/);
  assert.match(scan, /id="scan-form"/);
  assert.doesNotMatch(scan, /id="jobs-body"/);
  assert.doesNotMatch(scan, /id="companies-body"/);
  assert.match(decisions, /data-page="decisions"/);
  assert.match(decisions, /id="jobs-body"/);
  assert.doesNotMatch(decisions, /id="scan-form"/);
  assert.match(companies, /data-page="companies"/);
  assert.match(companies, /id="companies-body"/);
  assert.doesNotMatch(companies, /id="jobs-body"/);

  for (const html of [scan, decisions, companies]) {
    assert.match(html, /id="app-shell"/);
    assert.match(html, /shared\/app-shell\.js/);
  }
});
