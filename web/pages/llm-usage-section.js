// Daily Codex token usage per source, on the statistics page. Kept in its
// own module so the decision-statistics controller stays independent.
import { requestJson } from '../shared/api-client.js';
import { escapeHtml } from '../shared/formatters.js';

const elements = {
  summary: document.querySelector('#llm-daily-summary'),
  body: document.querySelector('#llm-daily-body'),
  model: document.querySelector('#llm-daily-model'),
  range: document.querySelector('[data-llm-days]')?.parentElement,
};

const sourceLabels = {
  linkedin: 'LinkedIn', whatsapp: 'WhatsApp', ats: 'ATS',
  system: 'מערכת (בדיקות מכסה, מחקר חברה)', unclassified: 'לא מסווג (לפני המדידה לפי מקור)', other: 'אחר',
};
const sourceOrder = ['linkedin', 'whatsapp', 'ats', 'other', 'system', 'unclassified'];
const tokens = (value) => Number(value || 0).toLocaleString('en-US');

function dayLabel(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' })
    .format(new Date(year, month - 1, date));
}

function totalsBySource(rows) {
  const totals = new Map();
  for (const row of rows) {
    const total = totals.get(row.source) || { source: row.source, tokens: 0, scored: 0, suitable: 0, limited: 0 };
    total.tokens += row.tokens;
    total.scored += row.scored;
    total.suitable += row.suitable;
    total.limited += row.limited;
    totals.set(row.source, total);
  }
  return [...totals.values()].sort((a, b) => sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source));
}

function render(data) {
  elements.model.textContent = `מודל: ${data.model}.`;
  const totals = totalsBySource(data.rows);
  const grand = totals.reduce((sum, row) => sum + row.tokens, 0);
  elements.summary.innerHTML = totals.length ? totals.map((row) => {
    const share = grand ? Math.round((row.tokens / grand) * 100) : 0;
    const perSuitable = row.suitable ? tokens(Math.round(row.tokens / row.suitable)) : '—';
    return `<article class="calibration-card llm-source-card" data-source="${escapeHtml(row.source)}">
      <span>${escapeHtml(sourceLabels[row.source] || row.source)}</span>
      <strong>${tokens(row.tokens)}</strong>
      <div class="decision-bar-track" aria-hidden="true"><i style="width:${share}%"></i></div>
      <small>${share}% מהצריכה · ${row.scored} נוקדו · ${row.suitable} מתאימות · ${perSuitable} טוקנים למתאימה${row.limited ? ` · ${Math.round(row.limited)} נחסמו במכסה` : ''}</small>
    </article>`;
  }).join('') : '<p class="stats-muted">עדיין אין צריכה מדודה בטווח הזה. המדידה לפי מקור מתחילה מהריצה הבאה.</p>';

  const rows = data.rows.filter((row) => row.tokens > 0 || row.scored > 0);
  elements.body.innerHTML = rows.map((row) => `<tr>
    <td>${escapeHtml(dayLabel(row.day))}</td>
    <td>${escapeHtml(sourceLabels[row.source] || row.source)}</td>
    <td>${tokens(row.tokens)}</td>
    <td>${row.scored}</td>
    <td>${row.suitable}</td>
    <td>${row.tokensPerSuitable == null ? '—' : tokens(row.tokensPerSuitable)}</td>
  </tr>`).join('') || '<tr><td colspan="6">אין נתונים בטווח.</td></tr>';
}

async function load(days) {
  try {
    render(await requestJson(`/api/llm-usage/daily?days=${Number(days)}`));
  } catch (error) {
    elements.body.innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
  }
}

elements.range?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-llm-days]');
  if (!button) return;
  for (const item of elements.range.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
  load(button.dataset.llmDays);
});

load(7);
