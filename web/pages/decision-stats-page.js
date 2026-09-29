import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime, validJobUrl } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  windows: document.querySelector('.stats-window'),
  total: document.querySelector('#stat-total'),
  positive: document.querySelector('#stat-positive'),
  pending: document.querySelector('#stat-pending'),
  bars: document.querySelector('#decision-bars'),
  calibration: document.querySelector('#calibration'),
  bands: document.querySelector('#bands-body'),
  sources: document.querySelector('#sources-body'),
  companies: document.querySelector('#companies'),
  recent: document.querySelector('#recent-body'),
  empty: document.querySelector('#stats-empty'),
  updated: document.querySelector('#last-updated'),
  sourceYield: document.querySelector('#source-yield-body'),
  sourceCompanies: document.querySelector('#source-companies'),
  sourceExclusive: document.querySelector('#source-exclusive-body'),
  sourceNote: document.querySelector('#source-value-note'),
};

const decisionLabels = {
  interested: 'מעניין אותי',
  company_candidate: 'חברה למעקב',
  company_not_interesting: 'חברה לא מעניינת',
  too_senior: 'בכיר מדי',
  not_relevant: 'תפקיד לא רלוונטי',
};
const sourceLabels = { whatsapp: 'WhatsApp', ats: 'ATS', linkedin: 'LinkedIn', unknown: 'לא ידוע' };
const bandLabels = { trial: 'טווח הניסיון (מתחת ל-4.0)', fit: 'מתאים', exact: 'בול מתאים' };

let stats = null;
let selectedWindow = '30d';

function percent(part, total) {
  return total ? `${Math.round((part / total) * 100)}%` : '—';
}

function bandRange(band) {
  const range = band.to == null ? `${band.from.toFixed(1)}+` : `${band.from.toFixed(1)}–${band.to.toFixed(1)}`;
  return `<bdi dir="ltr">${range}</bdi>`;
}

function renderBars(windowStats) {
  const max = Math.max(1, ...Object.values(windowStats.byDecision));
  elements.bars.innerHTML = Object.entries(decisionLabels).map(([key, label]) => {
    const count = windowStats.byDecision[key] || 0;
    return `<div class="decision-bar" data-decision="${key}">
      <span>${label}</span>
      <div class="decision-bar-track"><i style="width: ${(count / max) * 100}%"></i></div>
      <strong>${count}</strong><small>${percent(count, windowStats.total)}</small>
    </div>`;
  }).join('');
}

function calibrationCard(title, value, detail, state) {
  return `<article class="calibration-card" data-state="${state}"><strong>${value}</strong><span>${title}</span><small>${detail}</small></article>`;
}

function renderCalibration(calibration) {
  const seniorState = calibration.tooSeniorDespiteFit >= 3 ? 'warn' : 'ok';
  const relevantState = calibration.notRelevantDespiteFit >= 3 ? 'warn' : 'ok';
  const trialState = calibration.totalBelowLegacy === 0 ? 'ok'
    : calibration.positiveBelowLegacy === 0 && calibration.totalBelowLegacy >= 5 ? 'warn' : 'ok';
  elements.calibration.innerHTML = [
    calibrationCard(
      '"בכיר מדי" למרות ציון בכירות 4–5',
      `${calibration.tooSeniorDespiteFit}/${calibration.tooSeniorTotal}`,
      seniorState === 'warn' ? 'כדאי להדק את עוגן הבכירות בציון.' : 'העוגן של הבכירות מחזיק כרגע.',
      seniorState,
    ),
    calibrationCard(
      '"לא רלוונטי" למרות התאמה גבוהה',
      `${calibration.notRelevantDespiteFit}/${calibration.notRelevantTotal}`,
      relevantState === 'warn' ? 'כנראה חסר כלל בציון על סוג התפקיד — כדאי לבדוק את המשרות האלה.' : 'אין דפוס חוזר כרגע.',
      relevantState,
    ),
    calibrationCard(
      'עניינו אותך מתחת ל-4.0',
      `${calibration.positiveBelowLegacy}/${calibration.totalBelowLegacy}`,
      calibration.totalBelowLegacy === 0 ? 'עדיין אין החלטות על משרות מטווח הניסיון.'
        : trialState === 'warn' ? 'שום משרה מתחת ל-4.0 לא עניינה אותך — אפשר להחזיר את הסף ל-4.0.'
          : 'טווח הניסיון מביא משרות שמעניינות אותך.',
      trialState,
    ),
  ].join('');
}

function renderRateRows(rows, labelOf) {
  if (!rows.length) return '<tr><td colspan="3" class="stats-muted">אין נתונים עדיין</td></tr>';
  return rows.map((row) => `<tr><td>${labelOf(row)}</td><td>${row.total}</td><td>${row.positive} <small class="stats-muted">(${percent(row.positive, row.total)})</small></td></tr>`).join('');
}

function renderRecent(recent) {
  elements.empty.hidden = recent.length > 0;
  elements.recent.innerHTML = recent.map((item) => {
    const url = validJobUrl(item.applyUrl);
    const identity = `<span class="job-company">${escapeHtml(item.company || 'חברה לא ידועה')}</span><span class="job-title">${escapeHtml(item.title || 'משרה ללא כותרת')}</span>`;
    return `<tr>
      <td class="stats-muted">${escapeHtml(formatTime(item.decidedAt))}</td>
      <td class="job-identity">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${identity}</a>` : identity}</td>
      <td>${item.score == null ? '—' : escapeHtml(Number(item.score).toFixed(1))}</td>
      <td><span class="decision-pill" data-decision="${escapeHtml(item.decision)}">${escapeHtml(decisionLabels[item.decision] || item.decision)}</span></td>
    </tr>`;
  }).join('');
}

const dash = (value, suffix = '') => (value == null ? '—' : `${escapeHtml(value)}${suffix}`);

function renderSourceValue(value) {
  if (!value) return;
  elements.sourceYield.innerHTML = value.yield.map((row) => `<tr>
    <td>${escapeHtml(sourceLabels[row.source] || row.source)}</td>
    <td>${row.scans}</td><td>${row.medianScanSeconds != null && row.medianScanSeconds < 1 ? '&lt;1 שנ׳' : dash(row.medianScanSeconds, ' שנ׳')}</td>
    <td>${row.found}</td><td>${row.filtered}</td><td>${row.scored}</td>
    <td><strong>${row.suitable}</strong></td><td>${row.interested}</td>
    <td>${dash(row.suitablePerScan)}</td><td>${dash(row.scoredPerSuitable)}</td>
  </tr>`).join('');
  const { companies } = value;
  const topNames = companies.top.map((row) => `${escapeHtml(row.company)} (${row.suitable})`).join(', ');
  elements.sourceCompanies.innerHTML = [
    calibrationCard('חברות ATS שהביאו משרה מתאימה', `${companies.withSuitable}/${companies.watched}`,
      topNames ? `המובילות: ${topNames}` : 'עדיין אין משרה מתאימה מ-ATS בטווח.', companies.withSuitable ? 'ok' : 'warn'),
    calibrationCard('חברות שלא העבירו אף משרה את הסינון', `${companies.silent}/${companies.watched}`,
      'לא נמצאה אצלן אף משרה רלוונטית בישראל בטווח — מועמדות לסריקה שבועית במקום בכל ריצה.', companies.silent > companies.watched / 2 ? 'warn' : 'ok'),
    calibrationCard('חלק 3 החברות המובילות מהמתאימות', companies.topShare == null ? '—' : `${Math.round(companies.topShare * 100)}%`,
      'אחוז גבוה = מעט חברות מביאות כמעט הכל.', 'ok'),
  ].join('');
  elements.sourceExclusive.innerHTML = value.exclusivity.map((row) => `<tr>
    <td>${escapeHtml(sourceLabels[row.source] || row.source)}</td>
    <td>${row.fits}</td><td><strong>${row.exclusive}</strong></td><td>${row.shared}</td>
    <td>${row.medianLeadDays == null ? '—' : `<bdi dir="ltr">${row.medianLeadDays > 0 ? '+' : ''}${row.medianLeadDays}</bdi> ימים`}</td>
  </tr>`).join('');
  elements.sourceNote.textContent = `${value.windowDays} הימים האחרונים · ${value.totalFits} משרות מתאימות. `
    + 'הנתונים נאספים במלואם מ-29.9.2026; לפני כן חלק מההיסטוריה לא נשמרה.';
}

function render() {
  if (!stats) return;
  renderSourceValue(stats.sourceValue);
  const windowStats = stats.windows[selectedWindow];
  elements.total.textContent = windowStats.total;
  elements.positive.textContent = windowStats.positive;
  elements.pending.textContent = stats.pending;
  for (const button of elements.windows.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.window === selectedWindow));
  }
  renderBars(windowStats);
  renderCalibration(stats.calibration);
  elements.bands.innerHTML = renderRateRows(
    stats.scoreBands.filter((band) => band.total > 0 || band.key !== 'trial'),
    (band) => `${escapeHtml(bandLabels[band.key] || band.key)} <small class="stats-muted">${bandRange(band)}</small>`,
  );
  elements.sources.innerHTML = renderRateRows(stats.sources, (row) => escapeHtml(sourceLabels[row.key] || row.key));
  elements.companies.innerHTML = stats.rejectedCompanies.length
    ? `<p class="stats-subtitle">חברות שסימנת "לא מעניינת"</p><div class="company-chips">${stats.rejectedCompanies.map((row) => `<span>${escapeHtml(row.company)}${row.count > 1 ? ` <b>×${row.count}</b>` : ''}</span>`).join('')}</div>`
    : '';
  renderRecent(stats.recent);
}

async function loadStats() {
  try {
    stats = await requestJson('/api/decision-stats');
    render();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    setSystemStatus('error', error.message);
  }
}

elements.windows.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-window]');
  if (!button) return;
  selectedWindow = button.dataset.window;
  render();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });
await loadStats();
