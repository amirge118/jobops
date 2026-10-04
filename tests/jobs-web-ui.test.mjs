import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


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
  assert.match(app, /function renderWhatsAppHistory\(history, insights\)/);
  assert.match(app, /runAction\('process-backlog', \{ days: 7 \}\)/);
  assert.match(app, /lastCollectedAt/);
  assert.match(app, /runAction\('retry-failed'\)/);
  assert.match(app, /runAction\('mark-read'\)/);
  assert.doesNotMatch(app, /diagnostics\/history/);
});

test('scan page turns the last-scan panel into a failure overview with retry/discard actions', () => {
  const html = readWeb('scan.html');
  const app = readWeb('pages', 'scan-page.js');

  assert.match(html, /id="failure-overview" class="failure-overview" hidden/);
  assert.match(html, /id="failure-breakdown-body"/);
  assert.match(html, /id="archive-failed"/);
  assert.match(app, /function renderFailureOverview\(failures\)/);
  assert.match(app, /postJson\('\/api\/jobs\/archive-failed'\)/);
  assert.match(app, /bot_challenge: 'חסימת אתר \(הגנת אנטי-בוט\)'/);
  assert.match(app, /navigation_error: 'שגיאת ניווט בדפדפן'/);
});

test('dashboard keeps readiness and source details compact', () => {
  const html = readWeb('scan.html');
  const css = readWeb('styles.css');
  const app = readWeb('pages', 'scan-page.js');

  assert.match(html, /id="source-details" class="source-details"/);
  assert.doesNotMatch(html, /id="technical-details"/);
  assert.match(css, /\.summary-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.summary-grid article\s*\{[^}]*min-height:\s*56px/s);
  // No step numbering ("01 / סריקה") on any page.
  for (const page of ['scan.html', 'decisions.html', 'companies.html', 'personal-area.html', 'decision-stats.html']) {
    assert.doesNotMatch(readWeb(page), /class="step"/);
  }
  assert.match(css, /\.readiness-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.source-details\[hidden\]/);
  assert.match(app, /elements\.sourceDetails\.hidden = rows\.length === 0/);
  assert.match(app, /elements\.activity\.hidden = !actionRunning/);
});

test('decisions and companies keep explicit user-controlled actions', () => {
  const decisionsHtml = readWeb('decisions.html');
  const decisions = readWeb('pages', 'decisions-page.js');
  const companies = readWeb('pages', 'companies-page.js');

  assert.match(decisionsHtml, /<th>חברה, משרה והתאמה<\/th><th>סיכוי לעבור סינון<\/th><th>פעולות<\/th>/);
  assert.doesNotMatch(decisions, /decline-actions|לא בשבילי:'/);
  assert.match(decisionsHtml, /href="\/personal-area"/);
  assert.match(decisionsHtml, /פעולות/);
  assert.doesNotMatch(decisionsHtml, /תיאור קצר/);
  assert.doesNotMatch(decisionsHtml, /סיבת ההחלטה/);
  // Each job shows the screen estimate and its top few gaps; the aggregate lives in the personal area.
  assert.match(decisions, /renderScreenPass/);
  assert.match(decisions, /MAX_JOB_GAPS = 3/);
  assert.doesNotMatch(decisions, /transfer-gap-item|employer-priorities|personal-area\/items/);
  assert.match(decisions, /<details class="fit-evidence">/);
  assert.match(decisions, /השרת דורש הפעלה מחדש/);
  assert.match(decisions, /job-score-fit/);
  assert.match(decisions, /פתח משרה/);
  assert.doesNotMatch(decisions, /renderFitDetails/);
  assert.doesNotMatch(decisions, /job\.summary/);
  assert.doesNotMatch(decisions, /job\.decisionReason/);
  assert.match(decisions, /העבר חברה למועמדות/);
  // "Interested" only records the decision; the job was already opened to judge it.
  assert.doesNotMatch(decisions, /openAndArchiveJob|window\.open/);
  assert.match(decisions, /data-decision="interested"/);
  assert.match(decisions, /data-decision="company_candidate"/);
  assert.match(decisions, /company_not_interesting: 'חברה לא מעניינת'/);
  assert.match(decisions, /too_senior: 'בכיר מדי'/);
  assert.match(decisions, /\/api\/jobs\/\$\{encodeURIComponent\(jobKey\)\}\/decision/);
  assert.doesNotMatch(decisions, /\/archive`/);
  assert.doesNotMatch(decisions, />ארכיון</);
  assert.match(companies, /אשר והוסף למעקב/);
  assert.match(companies, /נדרש אישור לפני הוספה למעקב/);
  assert.match(companies, /\/api\/companies\/research/);
  assert.match(companies, /data-status-filter/);
  assert.match(companies, /statusOrder/);
  assert.match(companies, /עדיין אין לסורק מתאם/);
});

test('scan page exposes LinkedIn as a separately controllable source with visible coverage', () => {
  const html = readWeb('scan.html');
  const script = readWeb('pages', 'scan-page.js');
  assert.match(html, /<option value="linkedin">LinkedIn בלבד<\/option>/);
  assert.match(html, /id="linkedin-hours"/);
  assert.match(html, /אוטומטי — מאז ההצלחה האחרונה/);
  assert.match(html, /id="linkedin-panel"/);
  assert.match(html, /id="linkedin-enabled"/);
  assert.doesNotMatch(html, /linkedin-search-form|הוסף חיפוש/);
  assert.match(html, /config\/jobs\.yml<\/code> \(sources\.linkedin\)/);
  assert.match(html, /<th>חלון אחרון<\/th><th>הצלחה אחרונה<\/th><th>מצב<\/th><th>תוצאות<\/th><\/tr>/);
  assert.match(script, /function renderLinkedIn\(linkedin\)/);
  assert.match(script, /readiness\.readyFor\.linkedin/);
  assert.match(script, /'\/api\/linkedin\/enabled'/);
  assert.doesNotMatch(script, /\/api\/linkedin\/searches/);
  assert.match(script, /processingFor\('linkedin', search\.label\)/);
  // A failure is explained with a next step, never shown as "no jobs".
  assert.match(script, /rate_limited: \['LinkedIn הגביל את קצב הבקשות\.'/);
  assert.match(script, /no_matches_fallback/);
});

test('decisions show every source a merged job was found in', () => {
  const decisions = readWeb('pages', 'decisions-page.js');
  assert.match(decisions, /function renderSourceBadges\(job\)/);
  assert.match(decisions, /linkedin: 'LinkedIn'/);
  assert.doesNotMatch(decisions, /possibleDuplicateOf/);
  assert.match(decisions, /job-title">[^\n]*\$\{renderSourceBadges\(job\)\}/);
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

test('decision stats page is routed, navigable, and renders every section from the stats API', () => {
  const html = readWeb('decision-stats.html');
  const script = readWeb('pages', 'decision-stats-page.js');
  const shell = readWeb('shared', 'app-shell.js');
  assert.match(html, /data-page="decision-stats"/);
  assert.match(html, /data-window="7d"/);
  assert.match(html, /id="calibration"/);
  assert.match(html, /id="recent-body"/);
  assert.match(shell, /'decision-stats': 'סטטיסטיקה'/);
  assert.match(script, /requestJson\('\/api\/decision-stats'\)/);
  assert.match(script, /function renderCalibration/);
  assert.match(script, /validJobUrl\(item\.applyUrl\)/);
});

test('stats page shows what each source is worth', () => {
  const html = readWeb('decision-stats.html');
  const script = readWeb('pages', 'decision-stats-page.js');
  assert.match(html, /id="source-yield-body"/);
  assert.match(html, /id="source-exclusive-body"/);
  assert.match(script, /function renderSourceValue/);
  assert.match(script, /stats\.sourceValue/);
});
