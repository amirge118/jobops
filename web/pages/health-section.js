// "בריאות המערכת" on the scan page: what the scheduled health check
// (scripts/jobs/health-check.mjs) found, with a button to re-check now.
// Kept in its own module so the scan controller stays independent.
import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';

const elements = {
  panel: document.querySelector('#health-panel'),
  summary: document.querySelector('#health-summary'),
  list: document.querySelector('#health-findings'),
  recheck: document.querySelector('#recheck-health'),
};

const severityLabels = { error: 'דורש טיפול', warn: 'לבדוק', info: 'לידיעה' };

function render({ checkedAt, findings }) {
  const attention = findings.filter((finding) => finding.severity !== 'info');
  elements.panel.dataset.state = findings.some((finding) => finding.severity === 'error') ? 'error'
    : attention.length ? 'warn' : 'ok';
  const when = checkedAt ? `נבדק ${formatTime(checkedAt)}` : 'עדיין לא נבדק';
  elements.summary.textContent = attention.length
    ? `${attention.length} ${attention.length === 1 ? 'בעיה דורשת' : 'בעיות דורשות'} תשומת לב · ${when}`
    : `אין בעיות פתוחות · ${when}`;
  elements.list.innerHTML = findings.map((finding) => `<li data-severity="${escapeHtml(finding.severity)}">
    <span class="health-severity">${escapeHtml(severityLabels[finding.severity] || finding.severity)}</span>
    <div><strong>${escapeHtml(finding.title)}</strong>${finding.detail ? `<small>${escapeHtml(finding.detail)}</small>` : ''}
    <small class="health-since">מאז ${escapeHtml(formatTime(finding.firstSeenAt))}</small></div>
  </li>`).join('');
}

async function load(method = 'GET') {
  try {
    render(await requestJson('/api/health', { method }));
  } catch (error) {
    elements.summary.textContent = error.message;
  }
}

elements.recheck.addEventListener('click', async () => {
  elements.recheck.disabled = true;
  try { await load('POST'); } finally { elements.recheck.disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
await load();
