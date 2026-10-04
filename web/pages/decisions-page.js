import { postJson, requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime, syncStatCard } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

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

const declineLabels = {
  company_not_interesting: 'חברה לא מעניינת',
  too_senior: 'בכיר מדי',
  not_relevant: 'תפקיד לא רלוונטי',
};

const declineEffects = {
  company_not_interesting: 'משרות חדשות מהחברה הזו לא ייבדקו ולא יוצגו מעכשיו',
};

const screenLabels = {
  high: 'סיכוי גבוה לעבור סינון',
  medium: 'סיכוי בינוני לעבור סינון',
  low: 'סיכוי נמוך לעבור סינון',
};


const dimensionLabels = {
  cvMatch: 'התאמת קו״ח',
  seniority: 'בכירות',
  roleScope: 'אופי התפקיד',
  location: 'מיקום',
  sector: 'תחום',
};

function renderFitEvidence(fitBreakdown) {
  if (!fitBreakdown) return '';
  const rows = Object.entries(dimensionLabels)
    .filter(([key]) => fitBreakdown[key] != null)
    .map(([key, label]) => `<li><span class="fit-dimension">${escapeHtml(label)}</span><span class="fit-dimension-score">${escapeHtml(fitBreakdown[key])}</span>${fitBreakdown.evidence?.[key] ? `<small>${escapeHtml(fitBreakdown.evidence[key])}</small>` : ''}</li>`)
    .join('');
  const uncertainties = (fitBreakdown.uncertainties || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<details class="fit-evidence"><summary>למה הציון?</summary><ul>${rows}</ul>${uncertainties ? `<p class="fit-uncertainties-title">לא ברור מהמשרה</p><ul class="fit-uncertainties">${uncertainties}</ul>` : ''}</details>`;
}

// The analysis orders gaps by screening impact, so the first few are the ones
// that decide whether this job is worth applying to. The full picture across
// jobs lives in the personal area.
const MAX_JOB_GAPS = 3;
const gapKindLabels = {
  safe_addition: 'להוסיף לקו״ח',
  needs_confirmation: 'לאמת',
  experience_gap: 'פער',
};

function renderJobGaps(items) {
  if (!items?.length) return '<p class="job-gaps-clear">לא נמצאו פערים משמעותיים.</p>';
  return `<ul class="job-gaps">${items.slice(0, MAX_JOB_GAPS).map((item) => `<li title="${escapeHtml(item.suggestion || '')}">
    <span class="gap-kind" data-kind="${escapeHtml(item.kind)}">${escapeHtml(gapKindLabels[item.kind] || 'לבדיקה')}</span>
    <strong>${escapeHtml(item.term || item.keyword)}</strong>${item.importance === 'required' ? '<span class="gap-required">חובה</span>' : ''}
    <span class="job-gap-text">${escapeHtml(item.explanation)}</span>
  </li>`).join('')}</ul>`;
}

function renderScreenPass(resumeGap) {
  if (!resumeGap) {
    return '<div class="resume-gap-state is-failed"><strong>השרת דורש הפעלה מחדש</strong><span>הרץ npm run restart:local מה-Terminal.</span></div>';
  }
  if (resumeGap.status === 'unavailable') {
    return '<div class="resume-gap-state"><strong>חסר קובץ קורות חיים</strong><span>יש לעדכן את profile/03-current-resume.md.</span></div>';
  }
  if (resumeGap.status === 'pending') {
    return '<div class="resume-gap-state"><strong>ממתין לניתוח</strong><span>ההערכה תחושב בסריקה הבאה.</span></div>';
  }
  if (resumeGap.status === 'failed' || !resumeGap.screenPass) {
    return '<div class="resume-gap-state is-failed"><strong>אין הערכה</strong><span>אפשר לנסות שוב בסריקה הבאה.</span></div>';
  }
  const { level, reason } = resumeGap.screenPass;
  return `<div class="screen-pass" data-level="${escapeHtml(level)}"><strong>${escapeHtml(screenLabels[level] || 'הערכת סינון')}</strong><span>${escapeHtml(reason)}</span></div>${renderJobGaps(resumeGap.items)}`;
}

const sourceBadgeLabels = { ats: 'ATS', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

function renderSourceBadges(job) {
  const badges = (job.sourceKinds || []).map((kind) =>
    `<span class="source-badge" data-source="${escapeHtml(kind)}">${escapeHtml(sourceBadgeLabels[kind] || kind)}</span>`);
  return badges.length ? `<span class="source-badges">${badges.join('')}</span>` : '';
}

function renderJobs() {
  elements.empty.hidden = jobs.length > 0;
  // Three columns: identity with its score, the employer view (widest), and a
  // uniform 2x3 grid of actions.
  elements.body.innerHTML = jobs.map((job) => `<tr>
    <td class="job-identity">
      <span class="job-company">${escapeHtml(job.company || 'חברה לא ידועה')}</span><span class="job-title">${escapeHtml(job.title || 'משרה ללא כותרת')}</span>${renderSourceBadges(job)}
      <div class="job-score-fit"><span class="score">${job.score == null ? '—' : escapeHtml(Number(job.score).toFixed(1))}</span><span class="fit-pill ${job.suitable ? 'is-suitable' : ''}">${escapeHtml(job.fitLabel || 'מתאים')}</span></div>
      ${renderFitEvidence(job.fitBreakdown)}
    </td>
    <td class="resume-gap-cell">${renderScreenPass(job.resumeGap)}</td>
    <td><div class="job-actions" role="group" aria-label="פעולות למשרה">
      <a class="job-action-button job-open" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noreferrer">פתח משרה</a>
      <button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="interested" title="רושם את ההחלטה ומעביר לארכיון">מעניין אותי</button>
      <button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="company_candidate" title="מוסיף את החברה למועמדות למעקב ומעביר לארכיון">העבר חברה למועמדות</button>
      ${Object.entries(declineLabels).map(([decision, label]) => `<button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="${decision}" title="לא בשבילי: ${label}. רושם את ההחלטה ומעביר לארכיון${declineEffects[decision] ? `. ${declineEffects[decision]}` : ''}">${label}</button>`).join('')}
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

async function decideJob(jobKey, decision) {
  await postJson(`/api/jobs/${encodeURIComponent(jobKey)}/decision`, { decision });
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
  try {
    const { decision } = button.dataset;
    if (!decision) return;
    elements.feedback.dataset.state = '';
    if (decision === 'interested') {
      // The job was already opened with "פתח משרה" to judge it; no second tab.
      await decideJob(button.dataset.jobKey, decision);
      elements.feedback.innerHTML = 'נרשם כמעניין. החברה הוצעה למעקב — <a href="/companies">לאישור בעמוד החברות</a>.';
      return;
    }
    if (decision === 'company_candidate') {
      // Resolve first: if the company cannot be added, the job stays on the
      // page instead of being archived with a misleading decision.
      await postJson('/api/companies/resolve', { jobKey: button.dataset.jobKey });
      await decideJob(button.dataset.jobKey, decision);
      elements.feedback.innerHTML = 'החברה הועברה למועמדות והמשרה נרשמה. <a href="/companies">עבור לעמוד החברות (סינון "ממתינות") כדי לאשר אותה למעקב.</a>';
      return;
    }
    await decideJob(button.dataset.jobKey, decision);
    elements.feedback.innerHTML = `נרשם: ${escapeHtml(declineLabels[decision] || '')}. <a href="/decision-stats">לסטטיסטיקה</a>`;
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    button.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadJobs(); });
await loadJobs();
