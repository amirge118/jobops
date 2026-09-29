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
let transferredKeys = new Set();

const gapLabels = {
  safe_addition: 'אפשר להוסיף בבטחה',
  experience_gap: 'פער ניסיון',
  needs_confirmation: 'דורש אימות',
};

const declineLabels = {
  company_not_interesting: 'חברה לא מעניינת',
  too_senior: 'בכיר מדי',
  not_relevant: 'תפקיד לא רלוונטי',
};

const screenLabels = {
  high: 'סיכוי גבוה לעבור סינון',
  medium: 'סיכוי בינוני לעבור סינון',
  low: 'סיכוי נמוך לעבור סינון',
};

const weightLabels = { critical: 'קריטי', important: 'חשוב', nice: 'יתרון' };
const coverageLabels = { strong: 'מופיע בקו״ח', partial: 'חלקי בקו״ח', missing: 'חסר בקו״ח' };

const dimensionLabels = {
  cvMatch: 'התאמת קו״ח',
  seniority: 'בכירות',
  roleScope: 'אופי התפקיד',
  location: 'מיקום',
  sector: 'תחום',
};

function gapKey(jobKey, keyword) {
  return `${jobKey}::${keyword}`;
}

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

function renderEmployerView(resumeGap) {
  const screen = resumeGap.screenPass
    ? `<div class="screen-pass" data-level="${escapeHtml(resumeGap.screenPass.level)}"><strong>${escapeHtml(screenLabels[resumeGap.screenPass.level] || 'הערכת סינון')}</strong><span>${escapeHtml(resumeGap.screenPass.reason)}</span></div>`
    : '';
  const priorities = resumeGap.employerPriorities || [];
  const list = priorities.length
    ? `<div class="employer-priorities"><p class="employer-priorities-title">מה חשוב להם</p><ol>${priorities.map((item) => `<li data-coverage="${escapeHtml(item.coverage)}">
      <div><strong>${escapeHtml(item.priority)}</strong><span class="priority-weight" data-weight="${escapeHtml(item.weight)}">${escapeHtml(weightLabels[item.weight] || '')}</span><span class="priority-coverage">${escapeHtml(coverageLabels[item.coverage] || '')}</span></div>
      <small>${escapeHtml(item.note)}</small>
    </li>`).join('')}</ol></div>`
    : '';
  return screen || list ? `<div class="employer-view">${screen}${list}</div>` : '';
}

function renderResumeGap(resumeGap, job) {
  if (resumeGap?.status !== 'ready') return renderGapItems(resumeGap, job);
  return `${renderEmployerView(resumeGap)}${renderGapItems(resumeGap, job)}`;
}

function renderGapItems(resumeGap, job) {
  if (!resumeGap) {
    return '<div class="resume-gap-state is-failed"><strong>השרת דורש הפעלה מחדש</strong><span>הרץ npm run restart:local מה-Terminal כדי לטעון את הניתוח החדש.</span></div>';
  }
  if (resumeGap.status === 'unavailable') {
    return '<div class="resume-gap-state"><strong>חסר קובץ קורות חיים</strong><span>יש לעדכן את profile/03-current-resume.md כדי לקבל המלצות.</span></div>';
  }
  if (resumeGap.status === 'pending') {
    return '<div class="resume-gap-state"><strong>ממתין לניתוח</strong><span>הפערים ינותחו בסריקה הבאה.</span></div>';
  }
  if (resumeGap.status === 'failed') {
    return `<div class="resume-gap-state is-failed"><strong>הניתוח לא הושלם</strong><span>${escapeHtml(resumeGap.reason || 'אפשר לנסות שוב בסריקה הבאה.')}</span></div>`;
  }
  if (!resumeGap.items?.length) {
    return '<div class="resume-gap-state is-clear"><strong>לא נמצא שינוי קריטי</strong><span>אין המלצה בטוחה ובעלת ערך גבוה למשרה הזו.</span></div>';
  }
  return `<div class="resume-gap-list">${resumeGap.items.map((item, index) => {
    const transferred = transferredKeys.has(gapKey(job.jobKey, item.keyword));
    return `<article class="resume-gap-item" data-kind="${escapeHtml(item.kind)}">
    <div><span class="gap-kind">${escapeHtml(gapLabels[item.kind] || 'לבדיקה')}</span><span class="gap-importance">${item.importance === 'required' ? 'דרישת חובה' : 'יתרון'}</span></div>
    <strong>${escapeHtml(item.keyword)}</strong>
    <p>${escapeHtml(item.explanation)}</p>
    <small>${escapeHtml(item.suggestion)}</small>
    <button class="job-action-button transfer-gap-item${transferred ? ' is-transferred' : ''}" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-item-index="${index}" ${transferred ? 'disabled' : ''}>${transferred ? 'הועבר לאזור האישי ✓' : 'העבר לאזור אישי'}</button>
  </article>`;
  }).join('')}</div>`;
}

const sourceBadgeLabels = { ats: 'ATS', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

function renderSourceBadges(job) {
  const badges = (job.sourceKinds || []).map((kind) =>
    `<span class="source-badge" data-source="${escapeHtml(kind)}">${escapeHtml(sourceBadgeLabels[kind] || kind)}</span>`);
  if (job.possibleDuplicateOf) {
    badges.push('<span class="source-badge duplicate-badge" title="אותה חברה ואותו תפקיד כבר נמצאו ממקור אחר; לא אוחדו אוטומטית כי אין ראיה מדויקת שזו אותה משרה.">ייתכן כפילות</span>');
  }
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
    <td class="resume-gap-cell">${renderResumeGap(job.resumeGap, job)}</td>
    <td><div class="job-actions" role="group" aria-label="פעולות למשרה">
      <a class="job-action-button job-open" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noreferrer">פתח משרה</a>
      <button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="interested" title="פותח את המשרה, רושם את ההחלטה ומעביר לארכיון">מעניין אותי</button>
      <button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="company_candidate" title="מוסיף את החברה למועמדות למעקב ומעביר לארכיון">העבר חברה למועמדות</button>
      ${Object.entries(declineLabels).map(([decision, label]) => `<button class="job-action-button decide-job" type="button" data-job-key="${escapeHtml(job.jobKey)}" data-decision="${decision}" title="לא בשבילי: ${label}. רושם את ההחלטה ומעביר לארכיון">${label}</button>`).join('')}
    </div></td>
  </tr>`).join('');
}

async function loadJobs() {
  try {
    const [state, personalArea] = await Promise.all([
      requestJson('/api/jobs'),
      requestJson('/api/personal-area/items').catch(() => ({ items: [] })),
    ]);
    jobs = state.jobs || [];
    transferredKeys = new Set((personalArea.items || [])
      .filter((item) => item.sourceJobKey)
      .map((item) => gapKey(item.sourceJobKey, item.keyword)));
    syncStatCard(elements.suitable, state.stats.suitable);
    syncStatCard(elements.unopened, state.stats.unopened);
    renderJobs();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    setSystemStatus('error', error.message);
  }
}

async function transferGapItem(job, item) {
  await postJson('/api/personal-area/items', {
    keyword: item.keyword,
    kind: item.kind,
    importance: item.importance,
    explanation: item.explanation,
    suggestion: item.suggestion,
    sourceCompany: job.company,
    sourceTitle: job.title,
    sourceJobKey: job.jobKey,
  });
  transferredKeys.add(gapKey(job.jobKey, item.keyword));
  renderJobs();
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
  const job = jobs.find((item) => item.jobKey === button.dataset.jobKey);
  try {
    if (button.classList.contains('transfer-gap-item')) {
      const item = job?.resumeGap?.items?.[Number(button.dataset.itemIndex)];
      if (!item) return;
      await transferGapItem(job, item);
      elements.feedback.textContent = 'הנושא הועבר לאזור האישי.';
      elements.feedback.dataset.state = '';
      return;
    }
    const { decision } = button.dataset;
    if (!decision) return;
    elements.feedback.dataset.state = '';
    if (decision === 'interested') {
      await openAndArchiveJob(job, (jobKey) => decideJob(jobKey, decision));
      elements.feedback.textContent = 'נרשם כמעניין והמשרה נפתחה בלשונית חדשה.';
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
