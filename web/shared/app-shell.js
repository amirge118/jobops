import { requestJson } from './api-client.js';
import { startAdaptivePolling } from './polling.js';

const page = document.body.dataset.page;
const shell = document.querySelector('#app-shell');
const pageLabels = { scan: 'סריקה ותוצאה', decisions: 'החלטות', companies: 'חברות במעקב' };

shell.innerHTML = `
  <header class="topbar">
    <div>
      <p class="eyebrow">JOB SEARCH COMMAND CENTER</p>
      <h1>jobOps</h1>
      <p class="subtitle">חיפוש, התאמה ופתיחת משרות — ממקום אחד.</p>
    </div>
    <div id="system-status" class="system-status" data-state="idle">
      <span class="status-dot" aria-hidden="true"></span>
      <span id="status-label">מוכן לעבודה</span>
    </div>
  </header>
  <nav class="app-nav" aria-label="ניווט ראשי">
    ${Object.entries(pageLabels).map(([key, label]) => `
      <a href="/${key}" ${key === page ? 'aria-current="page"' : ''}>
        <span>${label}</span>
        <b id="nav-${key}-count" aria-label="מספר פריטים"></b>
      </a>`).join('')}
  </nav>`;

let actionRunning = false;

export function setSystemStatus(state, label) {
  const status = document.querySelector('#system-status');
  status.dataset.state = state;
  status.querySelector('#status-label').textContent = label;
}

export async function refreshShell() {
  try {
    const summary = await requestJson('/api/summary');
    actionRunning = summary.action.status === 'running';
    document.querySelector('#nav-decisions-count').textContent = summary.jobs.suitable || '';
    document.querySelector('#nav-companies-count').textContent = summary.companies.watched || '';
    document.querySelector('#nav-scan-count').textContent = actionRunning ? 'פעיל' : '';
    if (page !== 'scan') {
      setSystemStatus(actionRunning ? 'running' : 'idle', actionRunning ? 'סריקה מתבצעת ברקע…' : 'מוכן לעבודה');
    }
  } catch {
    if (page !== 'scan') setSystemStatus('error', 'לא ניתן לטעון את מצב המערכת');
  }
}

await refreshShell();
startAdaptivePolling(refreshShell, { isActive: () => actionRunning });
window.addEventListener('jobops:refresh-summary', refreshShell);
