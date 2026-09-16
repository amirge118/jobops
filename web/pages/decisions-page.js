import { postJson, requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime, syncStatCard } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';
import { openAndArchiveJob } from '../shared/job-actions.js';

const elements = {
  body: document.querySelector('#jobs-body'),
  empty: document.querySelector('#empty-state'),
  suitable: document.querySelector('#suitable-count'),
  unopened: document.querySelector('#unopened-count'),
  openJobs: document.querySelector('#open-jobs'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
};
let jobs = [];

function renderFitDetails(breakdown) {
  if (!breakdown) return '';
  const metrics = [
    ['ניסיון וטכנולוגיות', breakdown.cvMatch], ['בכירות', breakdown.seniority],
    ['היקף התפקיד', breakdown.roleScope], ['מיקום', breakdown.location], ['תחום', breakdown.sector],
  ];
  const uncertainties = Array.isArray(breakdown.uncertainties) ? breakdown.uncertainties : [];
  return `<details class="fit-details"><summary>למה הציון הזה?</summary><div class="fit-metrics">
    ${metrics.map(([label, score]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(score ?? '—')}/5</span>`).join('')}
    </div>${uncertainties.length ? `<p><b>מידע חסר:</b> ${escapeHtml(uncertainties.join(' · '))}</p>` : '<p>לא זוהו סימני שאלה מהותיים.</p>'}</details>`;
}

function renderJobs() {
  elements.empty.hidden = jobs.length > 0;
  elements.body.innerHTML = jobs.map((job) => `<tr>
    <td><span class="job-company">${escapeHtml(job.company || 'חברה לא ידועה')}</span><span class="job-title">${escapeHtml(job.title || 'משרה ללא כותרת')}</span></td>
    <td>${escapeHtml(job.summary || 'אין תיאור קצר')}</td>
    <td><span class="score">${job.score == null ? '—' : escapeHtml(Number(job.score).toFixed(1))}</span></td>
    <td><span class="fit-pill ${job.suitable ? 'is-suitable' : ''}">${escapeHtml(job.fitLabel || 'מתאים')}</span></td>
    <td>${escapeHtml(job.decisionReason || 'אין סיבת החלטה')}${renderFitDetails(job.fitBreakdown)}</td>
    <td><a class="job-link" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noreferrer">פתח משרה ↗</a></td>
    <td><div class="job-actions">
      <button class="open-archive-job" type="button" data-job-key="${escapeHtml(job.jobKey)}">פתח והעבר לארכיון</button>
      <button class="resolve-job-company" type="button" data-job-key="${escapeHtml(job.jobKey)}">העבר חברה למועמדות</button>
      <button class="archive-job" type="button" data-job-key="${escapeHtml(job.jobKey)}">רק להעביר לארכיון</button>
    </div></td>
  </tr>`).join('');
}

async function loadJobs() {
  try {
    const state = await requestJson('/api/jobs');
    jobs = state.jobs || [];
    syncStatCard(elements.suitable, state.stats.suitable);
    syncStatCard(elements.unopened, state.stats.unopened);
    renderJobs();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    setSystemStatus('error', error.message);
  }
}

async function archiveJob(jobKey) {
  await postJson(`/api/jobs/${encodeURIComponent(jobKey)}/archive`);
  await loadJobs();
  window.dispatchEvent(new Event('jobops:refresh-summary'));
}

elements.openJobs.addEventListener('click', async () => {
  elements.openJobs.disabled = true;
  try {
    await postJson('/api/actions/open-jobs');
    elements.feedback.textContent = 'פתיחת המשרות התחילה.';
    setSystemStatus('running', 'פותח משרות ב-Chrome…');
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
  } finally { elements.openJobs.disabled = false; }
});

elements.body.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-job-key]');
  if (!button) return;
  button.disabled = true;
  const job = jobs.find((item) => item.jobKey === button.dataset.jobKey);
  try {
    if (button.classList.contains('resolve-job-company')) {
      await postJson('/api/companies/resolve', { jobKey: button.dataset.jobKey });
      elements.feedback.innerHTML = 'החברה הועברה למועמדות. <a href="/companies">עבור לעמוד החברות (סינון "ממתינות") כדי לאשר אותה למעקב.</a>';
      return;
    }
    if (button.classList.contains('open-archive-job')) {
      await openAndArchiveJob(job, archiveJob);
      return;
    }
    await archiveJob(button.dataset.jobKey);
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    button.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadJobs(); });
await loadJobs();
