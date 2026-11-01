import { postJson, requestJson } from '../shared/api-client.js';

const STATUS_LABELS = { Evaluated: 'נבדקה', Applied: 'הגשתי', Responded: 'חזרו אליי', Interview: 'ראיון', Offer: 'הצעה', Rejected: 'נדחיתי', Discarded: 'ויתרתי', SKIP: 'לא מתאים' };
const FOLLOW_UP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const feedbackLine = document.querySelector('#page-feedback');
const rowsRoot = document.querySelector('#tracker-rows');
const search = document.querySelector('#tracker-search');
const statusFilter = document.querySelector('#tracker-status');
const followUpsOnly = document.querySelector('#tracker-follow-ups');
const summary = document.querySelector('#tracker-summary');
const drift = document.querySelector('#tracker-drift');
const addForm = document.querySelector('#tracker-add');
let data = { rows: [], statuses: [], fileDrift: false };

function feedback(message, isError = false) {
  feedbackLine.textContent = message;
  feedbackLine.dataset.state = isError ? 'error' : '';
}

const isFollowUp = (row) => row.status === 'Applied' && Date.now() - Date.parse(row.date) > FOLLOW_UP_DAYS * DAY_MS;
const statusLabel = (status) => STATUS_LABELS[status] ?? status;

function statusOptions(select, selected, { includeAll = false } = {}) {
  const options = data.statuses.includes(selected) || !selected ? data.statuses : [selected, ...data.statuses];
  select.replaceChildren(...(includeAll ? [new Option('הכול', '')] : []), ...options.map((status) => new Option(statusLabel(status), status)));
  select.value = selected ?? '';
}

async function saveRow(row, change) {
  try {
    const result = await postJson(`/api/tracker/${row.number}`, change);
    Object.assign(row, result.row);
    feedback(result.fileCopy === 'conflict' ? 'נשמר. הקובץ data/applications.md נערך ידנית ולכן לא עודכן.' : 'נשמר.');
    render();
  } catch (error) {
    feedback(error.message, true);
  }
}

function renderRow(row) {
  const tr = document.createElement('tr');
  if (isFollowUp(row)) tr.className = 'tracker-follow-up';
  const cell = (text) => Object.assign(document.createElement('td'), { textContent: text, dir: 'auto' });
  const status = document.createElement('select');
  status.setAttribute('aria-label', `סטטוס של ${row.company}`);
  statusOptions(status, row.status);
  status.addEventListener('change', () => saveRow(row, { status: status.value }));
  const notes = Object.assign(document.createElement('input'), { type: 'text', value: row.notes, dir: 'auto', maxLength: 2000 });
  notes.setAttribute('aria-label', `הערות על ${row.company}`);
  notes.addEventListener('change', () => saveRow(row, { notes: notes.value }));
  const statusCell = document.createElement('td');
  statusCell.append(status);
  const notesCell = document.createElement('td');
  notesCell.append(notes);
  tr.append(cell(row.date), cell(row.company), cell(row.role), cell(row.score), statusCell, notesCell);
  return tr;
}

function render() {
  const text = search.value.trim().toLowerCase();
  const visible = data.rows
    .filter((row) => !statusFilter.value || row.status === statusFilter.value)
    .filter((row) => !followUpsOnly.checked || isFollowUp(row))
    .filter((row) => !text || `${row.company} ${row.role} ${row.notes}`.toLowerCase().includes(text))
    .reverse();
  rowsRoot.replaceChildren(...visible.map(renderRow));
  const waiting = data.rows.filter(isFollowUp).length;
  summary.textContent = `${data.rows.length} מועמדויות, ${waiting} מחכות למעקב (הוגשו לפני יותר מ-${FOLLOW_UP_DAYS} ימים).`;
}

function renderDrift() {
  drift.hidden = !data.fileDrift;
  if (!data.fileDrift) return;
  const adopt = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-small button-secondary', textContent: 'קליטת הקובץ' });
  adopt.addEventListener('click', async () => {
    try {
      await postJson('/api/tracker/adopt-file');
      await load();
      feedback('הקובץ נקלט.');
    } catch (error) {
      feedback(error.message, true);
    }
  });
  const line = Object.assign(document.createElement('p'), { textContent: 'הקובץ data/applications.md נערך מחוץ לעמוד, והעמוד עדיין מציג את הרשומות השמורות. קליטה תחליף אותן בתוכן הקובץ.' });
  line.append(' ', adopt);
  drift.replaceChildren(line);
}

function buildAddForm() {
  const today = new Date().toLocaleDateString('sv-SE');
  const company = Object.assign(document.createElement('input'), { type: 'text', id: 'add-company', dir: 'auto', required: true, maxLength: 200 });
  const role = Object.assign(document.createElement('input'), { type: 'text', id: 'add-role', dir: 'auto', required: true, maxLength: 200 });
  const date = Object.assign(document.createElement('input'), { type: 'date', id: 'add-date', value: today, required: true });
  const status = Object.assign(document.createElement('select'), { id: 'add-status' });
  statusOptions(status, 'Applied');
  const fields = [['חברה', company], ['תפקיד', role], ['תאריך', date], ['סטטוס', status]].map(([label, input]) => {
    const wrapper = document.createElement('div');
    wrapper.append(Object.assign(document.createElement('label'), { htmlFor: input.id, textContent: label }), input);
    return wrapper;
  });
  addForm.replaceChildren(...fields, Object.assign(document.createElement('button'), { type: 'submit', className: 'button button-primary', textContent: 'הוספה' }));
  addForm.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await postJson('/api/tracker', { company: company.value, role: role.value, date: date.value, status: status.value });
      company.value = '';
      role.value = '';
      await load();
      feedback('נוסף.');
    } catch (error) {
      feedback(error.message, true);
    }
  };
}

async function load() {
  data = await requestJson('/api/tracker');
  statusOptions(statusFilter, statusFilter.value, { includeAll: true });
  renderDrift();
  render();
}

for (const control of [search, statusFilter, followUpsOnly]) control.addEventListener('input', render);

load().then(buildAddForm).catch((error) => feedback(error.message, true));
