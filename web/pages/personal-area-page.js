import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  main: document.querySelector('.page-main'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
  insightBodies: [...document.querySelectorAll('.gap-insights-body')],
  insightSummary: document.querySelector('#insights-summary'),
  hidden: document.querySelector('#hidden-terms'),
  hiddenCount: document.querySelector('#hidden-count'),
  hiddenList: document.querySelector('#hidden-list'),
};
let insights = null;

const kindLabels = {
  safe_addition: 'אפשר להוסיף עכשיו',
  needs_confirmation: 'לאמת לפני הוספה',
  experience_gap: 'צריך ללמוד',
};

function insightAction(row) {
  if (row.inResume) {
    return `<span class="gap-kind" data-kind="in_resume">${row.coverage.partial ? 'קיים, לחזק' : 'כבר בקורות החיים'}</span>`;
  }
  const label = row.kind ? kindLabels[row.kind] : 'חסר בקורות החיים';
  return `<span class="gap-kind" data-kind="${escapeHtml(row.kind || 'missing')}">${escapeHtml(label || 'לבדיקה')}</span>`;
}

function statusButton(term, status, label) {
  return `<button class="job-action-button term-status" type="button" data-term="${escapeHtml(term)}" data-status="${status}">${label}</button>`;
}

function renderInsightRow(row) {
  const inProgress = row.status === 'in_progress';
  const required = row.required ? `<small>${row.required} כדרישת חובה</small>` : '';
  const passed = row.lowWeight ? `<small>${row.lowWeight} שפסלת (משקל נמוך)</small>` : '';
  const evidence = row.evidence ? `<small>הוכחה בפרופיל: ${escapeHtml(row.evidence)}</small>` : '';
  return `<tr class="gap-insight-row" data-in-resume="${row.inResume}" data-status="${row.status || ''}">
    <td class="improvement-keyword">${escapeHtml(row.term)}${inProgress ? '<span class="term-badge">בטיפול</span>' : ''}</td>
    <td class="gap-insight-jobs"><strong>${row.jobs}</strong>${required}${passed}</td>
    <td>${insightAction(row)}</td>
    <td class="improvement-detail"><p>${escapeHtml(row.explanation || '')}</p>${row.suggestion ? `<small>${escapeHtml(row.suggestion)}</small>` : ''}${evidence}</td>
    <td class="improvement-source">${row.examples.map(escapeHtml).join(' · ') || '—'}</td>
    <td><div class="term-actions">${inProgress ? statusButton(row.term, '', 'בטל טיפול') : statusButton(row.term, 'in_progress', 'בטיפול')}${statusButton(row.term, 'hidden', 'הסתר')}</div></td>
  </tr>`;
}

function renderInsights() {
  const { totals, sections, hidden } = insights;
  elements.insightSummary.textContent = totals.jobs
    ? `נותחו ${totals.jobs} משרות מתאימות (${totals.strongFit} מהן בציון 4 ומעלה, ${totals.interested} סימנת כמעניינות${totals.lowWeight ? `, ${totals.lowWeight} פסלת ונספרות במשקל נמוך` : ''}). המספרים מראים בכמה משרות הפער הופיע.`
    : 'עדיין אין ניתוחים שמורים. הם יצטברו אוטומטית מכל משרה מתאימה בסריקות הבאות.';
  for (const body of elements.insightBodies) {
    const rows = sections[body.dataset.category] || [];
    body.innerHTML = rows.map(renderInsightRow).join('');
    document.querySelector(`[data-insight-empty="${body.dataset.category}"]`).hidden = rows.length > 0;
    document.querySelector(`[data-insight-count="${body.dataset.category}"]`).textContent = rows.length ? `(${rows.length})` : '';
  }
  elements.hidden.hidden = hidden.length === 0;
  elements.hiddenCount.textContent = `(${hidden.length})`;
  elements.hiddenList.innerHTML = hidden.map((item) => `<li><span>${escapeHtml(item.term)}</span><small>${item.jobs} משרות</small>${statusButton(item.term, '', 'החזר')}</li>`).join('');
}

async function loadInsights() {
  try {
    insights = await requestJson('/api/personal-area/insights');
    renderInsights();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    elements.insightSummary.textContent = error.message;
    setSystemStatus('error', error.message);
  }
}

elements.main.addEventListener('click', async (event) => {
  const button = event.target.closest('button.term-status');
  if (!button) return;
  button.disabled = true;
  try {
    await requestJson('/api/personal-area/term-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: button.dataset.term, status: button.dataset.status || null }),
    });
    elements.feedback.textContent = '';
    await loadInsights();
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    button.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadInsights(); });
await loadInsights();
