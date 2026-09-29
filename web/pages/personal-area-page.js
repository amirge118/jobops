import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  body: document.querySelector('#improvements-body'),
  empty: document.querySelector('#improvements-empty'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
};
let items = [];
let draggedId = null;

const kindLabels = {
  safe_addition: 'אפשר להוסיף בבטחה',
  experience_gap: 'פער ניסיון',
  needs_confirmation: 'דורש אימות',
};

function sourceLabel(item) {
  if (!item.sourceCompany && !item.sourceTitle) return '—';
  return [item.sourceCompany, item.sourceTitle].filter(Boolean).map(escapeHtml).join(' · ');
}

function renderItems() {
  elements.empty.hidden = items.length > 0;
  elements.body.innerHTML = items.map((item) => `<tr draggable="true" class="improvement-row" data-item-id="${item.id}">
    <td class="drag-handle" aria-hidden="true">⠿</td>
    <td class="improvement-keyword">${escapeHtml(item.keyword)}</td>
    <td><span class="gap-kind" data-kind="${escapeHtml(item.kind)}">${escapeHtml(kindLabels[item.kind] || 'לבדיקה')}</span></td>
    <td class="improvement-detail"><p>${escapeHtml(item.explanation)}</p><small>${escapeHtml(item.suggestion)}</small></td>
    <td class="improvement-source">${sourceLabel(item)}</td>
    <td><button class="job-action-button remove-improvement" type="button" data-item-id="${item.id}">הסר</button></td>
  </tr>`).join('');
}

async function loadItems() {
  try {
    const state = await requestJson('/api/personal-area/items');
    items = state.items || [];
    renderItems();
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
  const orderedIds = [...elements.body.querySelectorAll('tr[data-item-id]')]
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

elements.body.addEventListener('click', async (event) => {
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

elements.body.addEventListener('dragstart', (event) => {
  const row = event.target.closest('tr[data-item-id]');
  if (!row) return;
  draggedId = row.dataset.itemId;
  event.dataTransfer.effectAllowed = 'move';
  row.classList.add('is-dragging');
});

elements.body.addEventListener('dragend', (event) => {
  event.target.closest('tr[data-item-id]')?.classList.remove('is-dragging');
});

elements.body.addEventListener('dragover', (event) => {
  event.preventDefault();
  const row = event.target.closest('tr[data-item-id]');
  if (!row || row.dataset.itemId === draggedId) return;
  const dragged = elements.body.querySelector(`tr[data-item-id="${draggedId}"]`);
  if (!dragged) return;
  const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  row.parentElement.insertBefore(dragged, before ? row : row.nextSibling);
});

elements.body.addEventListener('drop', async (event) => {
  event.preventDefault();
  draggedId = null;
  await persistOrder();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadItems(); });
await loadItems();
