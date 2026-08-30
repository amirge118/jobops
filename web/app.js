const elements = {
  form: document.querySelector('#scan-form'),
  days: document.querySelector('#days'),
  source: document.querySelector('#source'),
  openAfter: document.querySelector('#open-after'),
  verify: document.querySelector('#verify-groups'),
  retryFailed: document.querySelector('#retry-failed'),
  markRead: document.querySelector('#mark-read'),
  openJobs: document.querySelector('#open-jobs'),
  status: document.querySelector('#system-status'),
  statusLabel: document.querySelector('#status-label'),
  activity: document.querySelector('#activity-card'),
  activityKicker: document.querySelector('#activity-kicker'),
  activityTitle: document.querySelector('#activity-title'),
  activityTime: document.querySelector('#activity-time'),
  activityDetails: document.querySelector('#activity-details'),
  activityOutput: document.querySelector('#activity-output'),
  suitable: document.querySelector('#suitable-count'),
  unopened: document.querySelector('#unopened-count'),
  groups: document.querySelector('#groups-count'),
  groupsList: document.querySelector('#groups-list'),
  minimumScore: document.querySelector('#minimum-score'),
  exactScore: document.querySelector('#exact-score'),
  body: document.querySelector('#jobs-body'),
  empty: document.querySelector('#empty-state'),
  updated: document.querySelector('#last-updated'),
  demoBanner: document.querySelector('#demo-banner'),
  healthTime: document.querySelector('#health-time'),
  atsHealth: document.querySelector('#ats-health'),
  whatsappHealth: document.querySelector('#whatsapp-health'),
  groupsHealth: document.querySelector('#groups-health'),
  runHealth: document.querySelector('#run-health'),
  atsHealthDot: document.querySelector('#ats-health-dot'),
  whatsappHealthDot: document.querySelector('#whatsapp-health-dot'),
  groupsHealthDot: document.querySelector('#groups-health-dot'),
  runHealthDot: document.querySelector('#run-health-dot'),
  runAuditBody: document.querySelector('#run-audit-body'),
  runAuditEmpty: document.querySelector('#run-audit-empty'),
};

let jobs = [];
let lastActionSignature = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function renderJobs() {
  elements.empty.hidden = jobs.length > 0;
  elements.body.innerHTML = jobs.map((job) => `
    <tr>
      <td>
        <span class="job-company">${escapeHtml(job.company || 'חברה לא ידועה')}</span>
        <span class="job-title">${escapeHtml(job.title || 'משרה ללא כותרת')}</span>
      </td>
      <td>${escapeHtml(job.summary || 'אין תיאור קצר')}</td>
      <td><span class="score">${job.score == null ? '—' : escapeHtml(Number(job.score).toFixed(1))}</span></td>
      <td><span class="fit-pill ${job.suitable ? 'is-suitable' : ''}">${escapeHtml(job.fitLabel || (job.suitable ? 'מתאים' : 'לא מתאים'))}</span></td>
      <td>
        ${escapeHtml(job.decisionReason || 'אין סיבת החלטה')}
        ${renderFitDetails(job.fitBreakdown)}
      </td>
      <td><a class="job-link" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noreferrer">פתח משרה ↗</a></td>
      <td><button class="archive-job" type="button" data-job-key="${escapeHtml(job.jobKey)}">העבר לארכיון</button></td>
    </tr>
  `).join('');
}

function renderFitDetails(breakdown) {
  if (!breakdown) return '';
  const metrics = [
    ['ניסיון וטכנולוגיות', breakdown.cvMatch],
    ['בכירות', breakdown.seniority],
    ['היקף התפקיד', breakdown.roleScope],
    ['מיקום', breakdown.location],
    ['תחום', breakdown.sector],
  ];
  const uncertainties = Array.isArray(breakdown.uncertainties) ? breakdown.uncertainties : [];
  return `
    <details class="fit-details">
      <summary>למה הציון הזה?</summary>
      <div class="fit-metrics">
        ${metrics.map(([label, score]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(score ?? '—')}/5</span>`).join('')}
      </div>
      ${uncertainties.length ? `<p><b>מידע חסר:</b> ${escapeHtml(uncertainties.join(' · '))}</p>` : '<p>לא זוהו סימני שאלה מהותיים.</p>'}
    </details>`;
}

function setHealth(element, dot, text, state) {
  element.textContent = text;
  dot.dataset.state = state;
}

const coverageLabels = {
  complete: 'מלא',
  partial: 'חלקי',
  unknown: 'לא ידוע',
  failed: 'נכשל',
  incomplete: 'כיסוי חלקי',
};

const failureLabels = {
  page_fetch_failed: 'פתיחת קישור',
  page_uncertain: 'עמוד לא ניתן לאימות',
  liveness_uncertain: 'סטטוס עמוד לא ברור',
  browser_error: 'דפדפן אוטומטי',
  fetch_error: 'רשת',
  hiremetech_api_error: 'HireMeTech API',
  hiremetech_api_timeout: 'HireMeTech timeout',
  scoring_failed: 'ציון Codex',
  unknown_failure: 'לא ידוע',
};

function formatFailureReasons(reasons = {}) {
  return Object.entries(reasons)
    .map(([code, count]) => `${failureLabels[code] || code}: ${count}`)
    .join(' · ');
}

function coverageFor(group) {
  if (group.error) return 'failed';
  if (group.coverage?.status) return group.coverage.status;
  return Number(group.messages || 0) > 0 ? 'partial' : 'unknown';
}

function runIsIncomplete(lastRun) {
  const whatsapp = lastRun?.details?.whatsapp;
  return lastRun?.status === 'incomplete' ||
    whatsapp?.coverageStatus === 'incomplete' ||
    Boolean(whatsapp?.warning);
}

function renderRunAudit(lastRun) {
  const { ats, whatsapp } = lastRun?.details || {};
  const processingScopes = lastRun?.details?.processing?.scopes || [];
  const processingFor = (source, name) => processingScopes.find(
    (scope) => scope.source === source && scope.name === name,
  );
  const rows = [];
  if (ats) {
    const status = Number(ats.errors || 0) > 0 ? 'partial' : 'complete';
    const processing = processingFor('ats', 'ATS');
    rows.push({
      name: 'ATS',
      coverage: status,
      received: Number(ats.found || 0),
      links: Number(processing?.links ?? ats.candidates ?? 0),
      processing,
      read: group.read,
      state: processing?.failed > 0
        ? 'חלק מהדפים לא נקראו'
        : status === 'complete' ? 'הושלם' : `${ats.errors} שגיאות איסוף`,
    });
  }
  for (const group of whatsapp?.groups || []) {
    const coverage = coverageFor(group);
    const processing = processingFor('whatsapp', group.name);
    rows.push({
      name: group.name,
      coverage,
      received: Number(group.coverage?.delivered ?? group.messages ?? 0),
      links: Number(processing?.links ?? group.candidates ?? 0),
      processing,
      state: group.error
        ? 'לא הצלחנו לסרוק'
        : processing?.failed > 0
          ? 'חלק מהקישורים נכשלו'
          : coverage === 'complete' ? 'הושלם' : 'הכיסוי לא הוכח',
    });
  }

  elements.runAuditEmpty.hidden = rows.length > 0;
  elements.runAuditBody.innerHTML = rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.name)}</strong></td>
      <td><span class="coverage-pill" data-state="${escapeHtml(row.coverage)}">${escapeHtml(coverageLabels[row.coverage] || row.coverage)}</span></td>
      <td>${escapeHtml(row.received)}${row.read ? `<small class="read-state">${row.read.marked ? ' · סומן כנקרא' : ' · לא סומן כנקרא'}</small>` : ''}</td>
      <td>${escapeHtml(row.links)}</td>
      <td class="processing-result">
        <span>נקראו ${escapeHtml(row.processing?.processed ?? 0)}</span>
        <span>מתאים ${escapeHtml(row.processing?.suitable ?? 0)}</span>
        <span>לא מתאים ${escapeHtml(row.processing?.notSuitable ?? 0)}</span>
        <span>כשל ${escapeHtml(row.processing?.failed ?? 0)}</span>
        <span>כבר נבדקו ${escapeHtml(row.processing?.alreadyProcessed ?? 0)}</span>
        ${row.processing?.failed > 0 ? `<small>סיבות: ${escapeHtml(formatFailureReasons(row.processing.failureReasons))}</small>` : ''}
      </td>
      <td>${escapeHtml(row.state)}</td>
    </tr>
  `).join('');
}

function renderHealth(lastRun, settings) {
  elements.demoBanner.hidden = !settings.demo;
  if (!lastRun) {
    setHealth(elements.atsHealth, elements.atsHealthDot, 'טרם נסרק', 'idle');
    setHealth(elements.whatsappHealth, elements.whatsappHealthDot, 'טרם נסרק', 'idle');
    setHealth(elements.groupsHealth, elements.groupsHealthDot, `${settings.groups.length} מוגדרות`, 'idle');
    setHealth(elements.runHealth, elements.runHealthDot, 'אין מידע', 'idle');
    elements.healthTime.textContent = '';
    return;
  }
  const { ats, whatsapp } = lastRun.details || {};
  const incomplete = runIsIncomplete(lastRun);
  const atsErrors = Number(ats?.errors || 0);
  setHealth(
    elements.atsHealth,
    elements.atsHealthDot,
    ats ? `${ats.candidates} מועמדויות, ${atsErrors} שגיאות` : 'לא נכלל בריצה',
    ats ? (atsErrors ? 'warn' : 'pass') : 'idle',
  );
  const groups = whatsapp?.groups || [];
  const foundGroups = groups.filter((group) => group.found && !group.error).length;
  setHealth(
    elements.whatsappHealth,
    elements.whatsappHealthDot,
    whatsapp ? `${whatsapp.receivedMessages ?? whatsapp.messages} התקבלו, ${whatsapp.messages} עובדו, ${whatsapp.candidates} קישורים` : 'לא נכלל בריצה',
    whatsapp ? (whatsapp.warning ? 'warn' : 'pass') : 'idle',
  );
  setHealth(
    elements.groupsHealth,
    elements.groupsHealthDot,
    `${foundGroups}/${settings.groups.length} נמצאו`,
    foundGroups === settings.groups.length && settings.groups.length > 0 ? 'pass' : 'warn',
  );
  setHealth(
    elements.runHealth,
    elements.runHealthDot,
    lastRun.status === 'success' && !incomplete
      ? 'הסתיימה בהצלחה'
      : incomplete ? 'כיסוי חלקי' : (lastRun.error || 'נכשלה'),
    lastRun.status === 'success' && !incomplete ? 'pass' : incomplete ? 'warn' : 'fail',
  );
  elements.healthTime.textContent = formatTime(lastRun.finished_at || lastRun.started_at);
}

function formatLastRun(lastRun) {
  const lines = [];
  const { ats, whatsapp } = lastRun.details || {};
  if (ats) {
    lines.push(`ATS: ${ats.candidates} מועמדויות, ${ats.found} נמצאו לפני סינון, ${ats.errors} שגיאות.`);
    if (ats.filtered) lines.push(`• סינון ATS: ${ats.filtered.title} לפי תפקיד, ${ats.filtered.location} לפי מיקום, ${ats.filtered.recency} לפי זמן.`);
  }
  if (whatsapp) {
    lines.push(`WhatsApp: ${whatsapp.receivedMessages ?? whatsapp.messages} התקבלו, ${whatsapp.messages} עובדו, ${whatsapp.candidates} קישורים.`);
    if (whatsapp.diagnostics) {
      lines.push(`סנכרון WhatsApp: ${whatsapp.diagnostics.deliveredMessages} הודעות נמסרו; ${whatsapp.diagnostics.historyNotifications ?? 0} חבילות history הוכרזו, ${whatsapp.diagnostics.historyEvents} הושלמו, ${whatsapp.diagnostics.upsertEvents} live; המתנה ${whatsapp.diagnostics.waitOutcome || 'לא ידוע'}.`);
    }
    for (const group of whatsapp.groups || []) {
      const coverage = coverageFor(group);
      lines.push(`• ${group.name}: ${group.messages} הודעות, ${group.candidates} קישורים, כיסוי ${coverageLabels[coverage] || coverage}${group.error ? ` — ${group.error}` : ''}`);
      if (group.read) lines.push(`  WhatsApp: ${group.read.marked ? 'סומן כנקרא' : `לא סומן כנקרא — ${group.read.error || 'ללא עוגן הודעה'}`}.`);
    }
    if (whatsapp.warning) lines.push(`⚠ ${whatsapp.warning}`);
  }
  for (const processing of lastRun.details?.processing?.scopes || []) {
    lines.push(`• עיבוד ${processing.name}: ${processing.links} קישורים, ${processing.processed} נקראו, ${processing.suitable} מתאימים, ${processing.notSuitable} לא מתאימים, ${processing.failed} נכשלו, ${processing.alreadyProcessed} כבר נבדקו.`);
    if (processing.failed > 0) lines.push(`  סיבות: ${formatFailureReasons(processing.failureReasons)}`);
  }
  return lines.join('\n') || lastRun.error || 'אין פירוט מקורות לריצה זו.';
}

function renderAction(action, lastRun) {
  const incomplete = runIsIncomplete(lastRun);
  const displayStatus = action.status === 'success' && incomplete
    ? 'incomplete'
    : action.status;
  const statusText = {
    idle: 'מוכן לעבודה',
    running: `${action.label || 'פעולה'} מתבצעת…`,
    success: 'הפעולה הסתיימה בהצלחה',
    incomplete: 'הפעולה הסתיימה בכיסוי חלקי',
    error: 'הפעולה נכשלה',
  }[displayStatus] || 'מוכן לעבודה';
  elements.status.dataset.state = displayStatus;
  elements.statusLabel.textContent = statusText;
  document.querySelectorAll('button, select, input').forEach((control) => {
    control.disabled = action.status === 'running';
  });

  if (action.status === 'idle' && !lastRun) {
    elements.activity.hidden = true;
    return;
  }
  elements.activity.hidden = false;
  if (action.status === 'running') elements.activityDetails.open = true;
  if (action.status === 'idle') {
    elements.activityKicker.textContent = 'סריקה אחרונה';
    elements.activityTitle.textContent = lastRun.status === 'success' && !incomplete
      ? 'הריצה הסתיימה בהצלחה'
      : incomplete
        ? 'הריצה הסתיימה בכיסוי חלקי'
        : `הריצה הסתיימה: ${lastRun.error || lastRun.status}`;
    elements.activityTime.textContent = formatTime(lastRun.finished_at || lastRun.started_at);
    elements.activityOutput.textContent = formatLastRun(lastRun);
    return;
  }
  elements.activityKicker.textContent = action.status === 'running' ? 'פעולה מתבצעת' : 'פעילות אחרונה';
  elements.activityTitle.textContent = action.error || action.label || 'פעולה';
  elements.activityTime.textContent = formatTime(action.finishedAt || action.startedAt);
  elements.activityOutput.textContent = action.output || (action.status === 'running' ? 'ממתין לפלט…' : 'הפעולה הסתיימה ללא פלט נוסף.');
  if (action.status === 'running') {
    elements.activityOutput.scrollTop = elements.activityOutput.scrollHeight;
  }
}

async function loadState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('לא ניתן לטעון את מצב המערכת');
    const state = await response.json();
    jobs = state.jobs || [];
    elements.suitable.textContent = state.stats.suitable;
    elements.unopened.textContent = state.stats.unopened;
    elements.groups.textContent = state.settings.groups.length;
    elements.verify.textContent = `אמת ${state.settings.groups.length} קבוצות WhatsApp`;
    elements.groupsList.innerHTML = state.settings.groups
      .map((group) => `<li>${escapeHtml(group.name)}</li>`)
      .join('');
    elements.minimumScore.textContent = Number(state.settings.minimumScore).toFixed(1);
    elements.exactScore.textContent = Number(state.settings.exactMatchScore).toFixed(1);
    elements.days.max = state.settings.maxLookbackDays;
    renderJobs();
    renderAction(state.action, state.lastRun);
    renderHealth(state.lastRun, state.settings);
    renderRunAudit(state.lastRun);
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;

    const signature = `${state.action.status}:${state.action.finishedAt || ''}`;
    if (lastActionSignature && signature !== lastActionSignature && state.action.status === 'success') {
      renderJobs();
    }
    lastActionSignature = signature;
  } catch (error) {
    elements.status.dataset.state = 'error';
    elements.statusLabel.textContent = error.message;
  }
}

async function runAction(name, payload = {}) {
  try {
    const response = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'הפעולה נכשלה');
    renderAction(result.action);
    await loadState();
  } catch (error) {
    elements.status.dataset.state = 'error';
    elements.statusLabel.textContent = error.message;
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAction('scan', {
    days: Number(elements.days.value),
    source: elements.source.value,
    open: elements.openAfter.checked,
  });
});
elements.verify.addEventListener('click', () => runAction('verify-groups'));
elements.retryFailed.addEventListener('click', () => runAction('retry-failed'));
elements.markRead.addEventListener('click', () => runAction('mark-read'));
elements.openJobs.addEventListener('click', () => runAction('open-jobs'));
elements.body.addEventListener('click', async (event) => {
  const button = event.target.closest('.archive-job');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(button.dataset.jobKey)}/archive`, {
      method: 'POST',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'העברת המשרה לארכיון נכשלה');
    jobs = result.state.jobs || [];
    renderJobs();
    elements.suitable.textContent = result.state.stats.suitable;
    elements.unopened.textContent = result.state.stats.unopened;
  } catch (error) {
    button.disabled = false;
    elements.status.dataset.state = 'error';
    elements.statusLabel.textContent = error.message;
  }
});

await loadState();
setInterval(loadState, 2_500);
