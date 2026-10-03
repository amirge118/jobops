import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  main: document.querySelector('.page-main'),
  bodies: [...document.querySelectorAll('.improvements-body')],
  empty: document.querySelector('#improvements-empty'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
};
let items = [];
let draggedId = null;

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

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadItems(); });
await loadItems();
