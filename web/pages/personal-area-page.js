import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  main: document.querySelector('.page-main'),
  bodies: [...document.querySelectorAll('.improvements-body')],
  empty: document.querySelector('#improvements-empty'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
  insightBodies: [...document.querySelectorAll('.gap-insights-body')],
  insightSummary: document.querySelector('#insights-summary'),
};
let items = [];
let draggedId = null;
let insights = null;

const kindLabels = {
  safe_addition: 'אפשר להוסיף עכשיו',
  needs_confirmation: 'לאמת לפני הוספה',
  experience_gap: 'צריך ללמוד',
};

// Each gap kind has its own table; unknown kinds fall into the first one.
const tableKinds = new Set(elements.bodies.map((body) => body.dataset.kind));
const tableKindOf = (item) => (tableKinds.has(item.kind) ? item.kind : 'safe_addition');

function sourceLabel(item) {
  if (!item.sourceCompany && !item.sourceTitle) return '—';
  return [item.sourceCompany, item.sourceTitle].filter(Boolean).map(escapeHtml).join(' · ');
}

function renderRow(item) {
  return `<tr draggable="true" class="improvement-row" data-item-id="${item.id}">
    <td class="drag-handle" aria-hidden="true">⠿</td>
    <td class="improvement-keyword">${escapeHtml(item.keyword)}</td>
    <td class="improvement-detail"><p>${escapeHtml(item.explanation)}</p><small>${escapeHtml(item.suggestion)}</small></td>
    <td class="improvement-source">${sourceLabel(item)}</td>
    <td><button class="job-action-button remove-improvement" type="button" data-item-id="${item.id}">הסר</button></td>
  </tr>`;
}

function renderItems() {
  elements.empty.hidden = items.length > 0;
  for (const body of elements.bodies) {
    const kindItems = items.filter((item) => tableKindOf(item) === body.dataset.kind);
    body.innerHTML = kindItems.map(renderRow).join('');
    document.querySelector(`[data-empty-for="${body.dataset.kind}"]`).hidden = kindItems.length > 0 || items.length === 0;
    document.querySelector(`[data-count-for="${body.dataset.kind}"]`).textContent = kindItems.length ? `(${kindItems.length})` : '';
  }
}

// Aggregated rows have no single source job; the term alone identifies them.
const isTracked = (row) => items.some((item) => !item.sourceJobKey && item.keyword === row.term);

function insightAction(row) {
  if (row.inResume) {
    return `<span class="gap-kind" data-kind="in_resume">${row.coverage.partial ? 'קיים, לחזק' : 'כבר בקורות החיים'}</span>`;
  }
  const label = row.kind ? kindLabels[row.kind] : 'חסר בקורות החיים';
  return `<span class="gap-kind" data-kind="${escapeHtml(row.kind || 'missing')}">${escapeHtml(label || 'לבדיקה')}</span>`;
}

function renderInsightRow(row, index) {
  const tracked = isTracked(row);
  const required = row.required ? `<small>${row.required} כדרישת חובה</small>` : '';
  const passed = row.lowWeight ? `<small>${row.lowWeight} שפסלת (משקל נמוך)</small>` : '';
  const evidence = row.evidence ? `<small>הוכחה בפרופיל: ${escapeHtml(row.evidence)}</small>` : '';
  return `<tr class="gap-insight-row" data-in-resume="${row.inResume}">
    <td class="improvement-keyword">${escapeHtml(row.term)}</td>
    <td class="gap-insight-jobs"><strong>${row.jobs}</strong>${required}${passed}</td>
    <td>${insightAction(row)}</td>
    <td class="improvement-detail"><p>${escapeHtml(row.explanation || '')}</p>${row.suggestion ? `<small>${escapeHtml(row.suggestion)}</small>` : ''}${evidence}</td>
    <td class="improvement-source">${row.examples.map(escapeHtml).join(' · ') || '—'}</td>
    <td><button class="job-action-button track-insight" type="button" data-category="${row.category}" data-index="${index}" ${tracked ? 'disabled' : ''}>${tracked ? 'ברשימה' : 'למעקב'}</button></td>
  </tr>`;
}

function renderInsights() {
  if (!insights) return;
  const { totals, sections } = insights;
  elements.insightSummary.textContent = totals.jobs
    ? `נותחו ${totals.jobs} משרות מתאימות (${totals.strongFit} מהן בציון 4 ומעלה, ${totals.interested} סימנת כמעניינות${totals.lowWeight ? `, ${totals.lowWeight} פסלת ונספרות במשקל נמוך` : ''}). המספרים מראים בכמה משרות הפער הופיע.`
    : 'עדיין אין ניתוחים שמורים. הם יצטברו אוטומטית מכל משרה מתאימה בסריקות הבאות.';
  for (const body of elements.insightBodies) {
    const rows = sections[body.dataset.category] || [];
    body.innerHTML = rows.map(renderInsightRow).join('');
    document.querySelector(`[data-insight-empty="${body.dataset.category}"]`).hidden = rows.length > 0;
    document.querySelector(`[data-insight-count="${body.dataset.category}"]`).textContent = rows.length ? `(${rows.length})` : '';
  }
}

async function loadInsights() {
  try {
    insights = await requestJson('/api/personal-area/insights');
    renderInsights();
  } catch (error) {
    elements.insightSummary.textContent = error.message;
  }
}

async function trackInsight(row) {
  const fallback = row.inResume ? 'להבליט בקורות החיים במקום בולט יותר.' : 'להוסיף לקורות החיים רק אם יש ניסיון אמיתי.';
  await requestJson('/api/personal-area/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyword: row.term,
      kind: row.kind || 'needs_confirmation',
      importance: row.required ? 'required' : 'preferred',
      explanation: row.explanation || `מופיע ב-${row.jobs} משרות מתאימות.`,
      suggestion: row.suggestion || fallback,
      sourceCompany: `${row.jobs} משרות`,
      sourceTitle: row.examples.join(', '),
    }),
  });
  await loadItems();
}

async function loadItems() {
  try {
    const state = await requestJson('/api/personal-area/items');
    items = state.items || [];
    renderItems();
    renderInsights();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    setSystemStatus('error', error.message);
  }
}

async function removeItem(id) {
  await requestJson(`/api/personal-area/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadItems();
}

async function persistOrder() {
  // Positions are global; DOM order across the tables keeps each table's own order.
  const orderedIds = [...elements.main.querySelectorAll('.improvements-body tr[data-item-id]')]
    .map((row) => Number(row.dataset.itemId));
  try {
    items = (await requestJson('/api/personal-area/items/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    })).items;
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    await loadItems();
  }
}

elements.main.addEventListener('click', async (event) => {
  const trackButton = event.target.closest('button.track-insight');
  if (trackButton) {
    trackButton.disabled = true;
    try {
      await trackInsight(insights.sections[trackButton.dataset.category][Number(trackButton.dataset.index)]);
    } catch (error) {
      elements.feedback.textContent = error.message;
      elements.feedback.dataset.state = 'error';
      trackButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest('button[data-item-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await removeItem(button.dataset.itemId);
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    button.disabled = false;
  }
});

elements.main.addEventListener('dragstart', (event) => {
  const row = event.target.closest('tr[data-item-id]');
  if (!row) return;
  draggedId = row.dataset.itemId;
  event.dataTransfer.effectAllowed = 'move';
  row.classList.add('is-dragging');
});

elements.main.addEventListener('dragend', (event) => {
  event.target.closest('tr[data-item-id]')?.classList.remove('is-dragging');
  draggedId = null;
});

elements.main.addEventListener('dragover', (event) => {
  const row = event.target.closest('tr[data-item-id]');
  if (!row || row.dataset.itemId === draggedId) return;
  const dragged = elements.main.querySelector(`tr[data-item-id="${draggedId}"]`);
  // Rows only move within their own table: the kind is not changed by dragging.
  if (!dragged || dragged.parentElement !== row.parentElement) return;
  event.preventDefault();
  const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  row.parentElement.insertBefore(dragged, before ? row : row.nextSibling);
});

elements.main.addEventListener('drop', async (event) => {
  if (!draggedId) return;
  event.preventDefault();
  draggedId = null;
  await persistOrder();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadItems(); loadInsights(); } });
await Promise.all([loadItems(), loadInsights()]);
