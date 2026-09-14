import { postJson, requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime, syncStatCard } from '../shared/formatters.js';
import { startAdaptivePolling } from '../shared/polling.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  form: document.querySelector('#scan-form'), days: document.querySelector('#days'),
  source: document.querySelector('#source'), openAfter: document.querySelector('#open-after'),
  submit: document.querySelector('#scan-form button[type="submit"]'),
  verify: document.querySelector('#verify-groups'), retryFailed: document.querySelector('#retry-failed'),
  markRead: document.querySelector('#mark-read'), openJobs: document.querySelector('#open-jobs'),
  refreshReadiness: document.querySelector('#refresh-readiness'),
  readinessPanel: document.querySelector('#readiness-panel'), readinessSummary: document.querySelector('#readiness-summary'),
  browserReadiness: document.querySelector('#browser-readiness'), scorerReadiness: document.querySelector('#scorer-readiness'),
  collectorReadiness: document.querySelector('#collector-readiness'),
  resultPanel: document.querySelector('#scan-result-panel'), resultTitle: document.querySelector('#result-title'),
  resultSummary: document.querySelector('#result-summary'), resultTime: document.querySelector('#result-time'),
  diagnosisIssues: document.querySelector('#diagnosis-issues'), sourceDetails: document.querySelector('#source-details'),
  technicalDetails: document.querySelector('#technical-details'), technicalSummary: document.querySelector('#technical-summary'),
  runAuditBody: document.querySelector('#run-audit-body'), runAuditEmpty: document.querySelector('#run-audit-empty'),
  activity: document.querySelector('#activity-card'), activityKicker: document.querySelector('#activity-kicker'),
  activityTitle: document.querySelector('#activity-title'), activityTime: document.querySelector('#activity-time'),
  activityDetails: document.querySelector('#activity-details'), activityOutput: document.querySelector('#activity-output'),
  suitable: document.querySelector('#suitable-count'), unopened: document.querySelector('#unopened-count'),
  groups: document.querySelector('#groups-count'), groupsList: document.querySelector('#groups-list'),
  minimumScore: document.querySelector('#minimum-score'), exactScore: document.querySelector('#exact-score'),
  backlogTotal: document.querySelector('#backlog-total'), backlogSummary: document.querySelector('#backlog-summary'),
  backlogGroups: document.querySelector('#history-groups-body'), processRecentBacklog: document.querySelector('#process-recent-backlog'),
  requestHistory: document.querySelector('#request-history'), historyRequestStatus: document.querySelector('#history-request-status'),
  updated: document.querySelector('#last-updated'), demoBanner: document.querySelector('#demo-banner'),
};

let actionRunning = false;
let historyRequestRunning = false;
let readiness = null;
let backlogState = { total: 0, recentTotal: 0 };

const coverageLabels = { complete: 'מלא', partial: 'חלקי', unknown: 'לא ידוע', failed: 'נכשל', incomplete: 'חלקי' };
const failureLabels = {
  page_fetch_failed: 'פתיחת קישור', page_uncertain: 'עמוד לא ניתן לאימות',
  browser_error: 'דפדפן אוטומטי', fetch_error: 'רשת', scoring_failed: 'מנגנון התאמה',
  codex_usage_limit: 'מכסת Codex', rate_limited: 'הגבלת קצב', timeout: 'תם הזמן',
  network_error: 'רשת', http_error: 'שגיאת HTTP', authentication_required: 'נדרשת התחברות',
  unknown_failure: 'לא ידוע',
};

function setReadinessCard(card, component) {
  const state = component?.status === 'ready' ? 'pass' : 'fail';
  card.dataset.state = state;
  card.querySelector('.health-dot').dataset.state = state;
  card.querySelector('span:last-child').textContent = component?.status === 'ready'
    ? 'מוכן'
    : component?.reason || 'לא זמין';
  card.title = component?.nextStep || '';
}

function selectedSourceReady() {
  if (!readiness) return false;
  return elements.source.value === 'ats' ? readiness.readyFor.ats : readiness.readyFor.whatsapp;
}

function syncControls() {
  for (const control of elements.form.querySelectorAll('select, input, button')) control.disabled = actionRunning;
  for (const control of [elements.verify, elements.markRead, elements.openJobs, elements.refreshReadiness,
    elements.requestHistory]) control.disabled = actionRunning;
  elements.retryFailed.disabled = actionRunning || readiness?.browser?.status !== 'ready' || readiness?.scorer?.status !== 'ready';
  const backlogRuntimeBlocked = readiness?.readyFor?.ats !== true;
  elements.processRecentBacklog.disabled = actionRunning || backlogRuntimeBlocked || backlogState.recentTotal === 0;
  const backlogTitle = backlogRuntimeBlocked
    ? 'עיבוד הקישורים דורש דפדפן אוטומטי ומנגנון התאמה זמינים.'
    : '';
  elements.processRecentBacklog.title = backlogTitle;
  elements.requestHistory.disabled = actionRunning || historyRequestRunning;
  elements.submit.disabled = actionRunning || !selectedSourceReady();
  elements.submit.title = selectedSourceReady() ? '' : 'יש לתקן את בדיקת המוכנות לפני הפעלת הסריקה.';
}

function renderReadiness(nextReadiness) {
  readiness = nextReadiness;
  setReadinessCard(elements.browserReadiness, readiness.browser);
  setReadinessCard(elements.scorerReadiness, readiness.scorer);
  setReadinessCard(elements.collectorReadiness, readiness.collector);
  const runtimeReady = readiness.readyFor.ats;
  elements.readinessPanel.dataset.state = readiness.readyFor.whatsapp ? 'ready' : runtimeReady ? 'partial' : 'blocked';
  elements.readinessSummary.textContent = readiness.readyFor.whatsapp
    ? 'המערכת מוכנה לסריקת ATS ו-WhatsApp.'
    : runtimeReady
      ? 'ATS מוכן. כדי לכלול WhatsApp צריך להפעיל את ה-Collector.'
      : readiness.browser.reason || readiness.scorer.reason || 'המערכת אינה מוכנה לסריקה.';
  syncControls();
}

function formatFailureReasons(reasons = {}) {
  return Object.entries(reasons).map(([code, count]) => `${failureLabels[code] || code}: ${count}`).join(' · ');
}

function coverageFor(group) {
  if (group.error) return 'failed';
  return group.coverage?.status || (Number(group.messages || 0) > 0 ? 'partial' : 'unknown');
}

function readStateLabel(read) {
  if (!read) return '';
  if (read.method === 'local-backlog') return 'עיבוד מקומי — ללא שינוי מצב הקריאה ב-WhatsApp';
  if (read.method === 'collector-unconfirmed') return 'מצב הקריאה אינו ניתן לאימות לפי קבוצה';
  if (read.status === 'skipped') return 'לא נשלחו אישורי קריאה — לא התקבלו הודעות בסריקה';
  if (read.method === 'scan-message-receipts') return `אישורי קריאה: ${Number(read.messages || 0)} הודעות`;
  if (read.method === 'collector-message-receipts') return `ה-Collector סימן ${Number(read.messages || 0)} הודעות`;
  return read.marked ? 'סומן כנקרא' : 'לא סומן כנקרא';
}

// Three simple states cover what a person actually needs to know at a
// glance; the rest (coverage/historyStatus/historyReason/gapFrom/read
// counts/link counts) is real and useful, but only on request — see
// groupDetailsRow(). "live" and "live-with-gap" both mean the collector is
// connected and reading right now; a gap from before it connected doesn't
// change that, so it must not read as a failure.
const syncPillState = { live: 'complete', 'live-with-gap': 'complete', recovering: 'partial', gap: 'failed', offline: 'failed' };
const syncLabels = {
  live: 'קורא עכשיו',
  'live-with-gap': 'קורא עכשיו',
  recovering: 'משלים פער…',
  gap: 'לא מחובר',
  offline: 'לא מחובר',
};
const historyReasonLabels = {
  missing_anchor: 'אין נקודת התחלה אמינה', anchor_too_old: 'נקודת ההתחלה ישנה מדי',
  history_no_response: 'WhatsApp לא החזיר את עמוד ההיסטוריה',
  history_request_timeout: 'בקשת ההיסטוריה חרגה מהזמן',
  history_no_progress: 'הבקשה לא התקדמה אחורה בזמן',
  newer_messages_unverified: 'הקצה החדש של הטווח לא אומת',
  history_batch_limit: 'הגענו למגבלת האצוות', history_deadline: 'הגענו למגבלת הזמן',
};

function groupDetailsRow(group, index) {
  const rows = [
    ['כיסוי הסריקה האחרונה', coverageLabels[group.coverage] || group.coverage || 'לא ידוע'],
    ['איסוף אחרון', group.lastCollectedAt ? formatTime(group.lastCollectedAt) : 'טרם נאסף מידע'],
    ['נקרא לאחרונה (WhatsApp)', group.lastReadAt ? formatTime(group.lastReadAt) : 'טרם אומת'],
    ['הודעות שנקראו סה"כ', Number(group.readTotal || 0)],
    ['הודעות שנאספו סה"כ', Number(group.collectedTotal || 0)],
    ['הגיעו בסריקה האחרונה', Number(group.received || 0)],
    ['קישורים שחולצו', Number(group.links || 0)],
    ['מתאימות', Number(group.suitable || 0)],
    ['נכשלו', Number(group.failed || 0)],
  ];
  if (group.gapFrom) rows.push(['פער היסטוריה פתוח מ-', formatTime(group.gapFrom)]);
  if (group.historyReason) rows.push(['סיבת הפער', historyReasonLabels[group.historyReason] || group.historyReason]);
  return `<tr class="group-details-row" data-group-details="${index}" hidden><td colspan="5">
    <dl class="group-details-grid">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('')}</dl>
  </td></tr>`;
}

function renderWhatsAppHistory(history) {
  const backlog = history?.backlog || { total: 0, recentTotal: 0, failed: 0, groups: [] };
  backlogState = {
    total: Number(backlog.total || 0),
    recentTotal: Number(backlog.recentTotal || 0),
  };
  elements.backlogTotal.textContent = Number(backlog.total || 0);
  elements.backlogSummary.textContent = backlog.total
    ? `${Number(backlog.total || 0)} הודעות חדשות נאספו בשבעת הימים האחרונים ומוכנות לחילוץ קישורים.`
    : 'אין הודעות חדשות שממתינות לעיבוד. אפשר להשלים פערים; הבקשה תמתין אם ה-Collector אינו מחובר.';
  elements.processRecentBacklog.textContent = `עבד הודעות שנאספו (${Number(backlog.total || 0)})`;
  elements.backlogGroups.innerHTML = (backlog.groups || []).map((group, index) => `<tr>
    <td><strong>${escapeHtml(group.name)}</strong></td>
    <td><span class="coverage-pill" data-state="${syncPillState[group.syncState] || 'unknown'}">${escapeHtml(syncLabels[group.syncState] || 'מצב לא ידוע')}</span></td>
    <td>${Number(group.total || 0)}</td>
    <td>${group.lastProcessedAt ? escapeHtml(formatTime(group.lastProcessedAt)) : 'טרם עובד'}</td>
    <td><button type="button" class="link-button" data-group-toggle="${index}">פרטים נוספים</button></td>
  </tr>${groupDetailsRow(group, index)}`).join('') || '<tr><td colspan="5">אין קבוצות מוגדרות</td></tr>';

  const request = history?.request;
  historyRequestRunning = ['pending', 'running'].includes(request?.status);
  syncControls();
  // This reflects the *last time anyone explicitly asked* for old history
  // (the "השלם פערים" button below, or the equivalent API) — never something
  // a regular scan retries on its own. A finished (non-running) request from
  // hours ago is stale, not current status, and showing it without an age
  // reads as "this is happening right now" when it may be from yesterday.
  const requestIsLive = request && ['pending', 'running'].includes(request.status);
  const requestIsRecent = request && Date.now() - Number(request.finishedAt || request.createdAt || 0) < 3 * 60 * 60 * 1_000;
  elements.historyRequestStatus.hidden = !request || !(requestIsLive || requestIsRecent);
  if (!request || !(requestIsLive || requestIsRecent)) return;
  // "נכשל" reads as an app malfunction, but the common case is WhatsApp
  // itself declining to hand over old history — live collection of new
  // messages is unaffected either way, so say that explicitly instead of
  // leaving it to be inferred.
  const statusLabels = {
    pending: 'ממתין לקולקטור', running: 'משלים היסטוריה ישנה…', complete: 'הושלמה',
    partial: 'הושלמה חלקית', failed: 'לא זמינה כרגע',
  };
  const groups = request.groups || [];
  const reasons = new Set(groups.map((group) => group.reason).filter(Boolean));
  const sameReasonForAll = groups.length > 0 && reasons.size === 1 && groups.every((group) => group.reason);
  const groupResults = sameReasonForAll
    ? `כל ${groups.length} הקבוצות: ${historyReasonLabels[[...reasons][0]] || [...reasons][0]}. זה לא משפיע על קליטת הודעות חדשות — היא ממשיכה כרגיל.`
    : groups.map((group) =>
      `${group.name}: ${Number(group.delivered || 0)} התקבלו, ${Number(group.queued || 0) + Number(group.duplicates || 0)} זמינות מקומית${group.reason ? ` — ${historyReasonLabels[group.reason] || group.reason}` : ''}`,
    ).join(' · ');
  elements.historyRequestStatus.dataset.state = request.status;
  elements.historyRequestStatus.innerHTML = `<strong>השלמת היסטוריה ישנה: ${escapeHtml(statusLabels[request.status] || request.status)}</strong>
    <span>${requestIsLive ? 'התחילה' : 'בוצעה'} ${escapeHtml(formatTime(request.createdAt))} · ${Number(request.groupsCompleted || 0)}/${Number(request.groupsTotal || 0)} קבוצות · ${Number(request.messagesReceived || 0)} הודעות התקבלו · ${Number(request.messagesQueued || 0) + Number(request.duplicates || 0)} זמינות מקומית</span>
    ${groupResults ? `<small>${escapeHtml(groupResults)}</small>` : ''}`;
}

function atsCountLabel(ats) {
  if (ats.discovery) return `${ats.discovery.found} נמצאו · ${ats.discovery.new} חדשות · ${ats.discovery.known} מוכרות`;
  return `${Number(ats.candidates || 0)} מועמדויות`;
}

function renderRunAudit(lastRun) {
  const { ats, whatsapp } = lastRun?.details || {};
  const scopes = lastRun?.details?.processing?.scopes || [];
  const processingFor = (source, name) => scopes.find((scope) => scope.source === source && scope.name === name);
  const rows = [];
  if (ats) {
    const processing = processingFor('ats', 'ATS');
    const coverage = Number(ats.errors || 0) > 0 ? 'partial' : 'complete';
    rows.push({ name: 'ATS', note: atsCountLabel(ats), coverage, received: Number(ats.found || 0),
      links: Number(processing?.links ?? ats.candidates ?? 0), processing,
      state: processing?.failed > 0 ? 'חלק מהעיבוד נכשל' : coverage === 'complete' ? 'הושלם' : 'איסוף חלקי' });
  }
  for (const group of whatsapp?.groups || []) {
    const coverage = coverageFor(group);
    const processing = processingFor('whatsapp', group.name);
    rows.push({ name: group.name, coverage, received: Number(group.coverage?.delivered ?? group.messages ?? 0),
      read: group.read, links: Number(processing?.links ?? group.candidates ?? 0), processing,
      state: group.error ? 'לא נסרקה' : processing?.failed > 0 ? 'חלק מהעיבוד נכשל' : coverage === 'complete' ? 'הושלם' : 'כיסוי לא מוכח' });
  }
  elements.sourceDetails.hidden = rows.length === 0;
  elements.runAuditEmpty.hidden = rows.length > 0;
  elements.runAuditBody.innerHTML = rows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.name)}</strong>${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}</td>
    <td><span class="coverage-pill" data-state="${escapeHtml(row.coverage)}">${escapeHtml(coverageLabels[row.coverage] || row.coverage)}</span></td>
    <td>${escapeHtml(row.received)}${row.read ? `<small class="read-state">${escapeHtml(readStateLabel(row.read))}</small>` : ''}</td>
    <td>${escapeHtml(row.links)}</td>
    <td class="processing-result"><span>נקראו ${escapeHtml(row.processing?.processed ?? 0)}</span><span>מתאים ${escapeHtml(row.processing?.suitable ?? 0)}</span><span>לא מתאים ${escapeHtml(row.processing?.notSuitable ?? 0)}</span><span>כשל ${escapeHtml(row.processing?.failed ?? 0)}</span>${row.processing?.failed > 0 ? `<small>${escapeHtml(formatFailureReasons(row.processing.failureReasons))}</small>` : ''}</td>
    <td>${escapeHtml(row.state)}</td>
  </tr>`).join('');
}

function renderDiagnosis(diagnosis, lastRun) {
  elements.resultPanel.dataset.state = diagnosis.status;
  elements.resultTitle.textContent = diagnosis.title;
  elements.resultSummary.textContent = diagnosis.summary;
  elements.resultTime.textContent = formatTime(lastRun?.finished_at || lastRun?.started_at);
  elements.diagnosisIssues.hidden = diagnosis.issues.length === 0;
  elements.diagnosisIssues.innerHTML = diagnosis.issues.map((issue) => `<article>
    <span class="issue-icon">!</span><div><strong>${escapeHtml(issue.title)}</strong><p>${escapeHtml(issue.reason)}</p><p><b>מה לעשות:</b> ${escapeHtml(issue.nextStep || 'בדוק שוב את מוכנות המערכת.')}</p></div>
  </article>`).join('');
  const codes = diagnosis.technical.codes.length ? diagnosis.technical.codes.join(', ') : 'none';
  elements.technicalDetails.hidden = !diagnosis.technical.runId;
  elements.technicalSummary.textContent = diagnosis.technical.runId ? `run #${diagnosis.technical.runId} · ${codes}` : 'No scan yet';
  if (!actionRunning) {
    const statusText = diagnosis.status === 'success' ? 'הסריקה האחרונה הצליחה'
      : diagnosis.status === 'empty' ? 'מוכן לעבודה' : diagnosis.title;
    setSystemStatus(diagnosis.status === 'failed' ? 'error' : diagnosis.status, statusText);
  }
}

function renderAction(action) {
  actionRunning = action.status === 'running';
  elements.activity.hidden = !actionRunning;
  if (!actionRunning) { syncControls(); return; }
  setSystemStatus('running', `${action.label || 'פעולה'} מתבצעת…`);
  elements.activityKicker.textContent = 'פעולה מתבצעת';
  elements.activityTitle.textContent = action.label || 'סריקה';
  elements.activityTime.textContent = formatTime(action.startedAt);
  elements.activityOutput.textContent = action.output || 'ממתין לפלט…';
  elements.activityDetails.open = true;
  elements.activityOutput.scrollTop = elements.activityOutput.scrollHeight;
  syncControls();
}

async function loadScan({ refreshReadiness = false } = {}) {
  try {
    const state = await requestJson(`/api/scan${refreshReadiness ? '?refresh=1' : ''}`);
    syncStatCard(elements.suitable, state.stats.suitable);
    syncStatCard(elements.unopened, state.stats.unopened);
    syncStatCard(elements.groups, state.settings.groups.length);
    elements.verify.textContent = `אמת ${state.settings.groups.length} קבוצות WhatsApp`;
    elements.groupsList.innerHTML = state.settings.groups.map((group) => `<li>${escapeHtml(group.name)}</li>`).join('');
    elements.minimumScore.textContent = Number(state.settings.minimumScore).toFixed(1);
    elements.exactScore.textContent = Number(state.settings.exactMatchScore).toFixed(1);
    elements.days.max = state.settings.maxLookbackDays;
    elements.demoBanner.hidden = !state.settings.demo;
    renderAction(state.action);
    renderReadiness(state.readiness);
    renderDiagnosis(state.diagnosis, state.lastRun);
    renderRunAudit(state.lastRun);
    renderWhatsAppHistory(state.whatsappHistory);
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
    window.dispatchEvent(new Event('jobops:refresh-summary'));
  } catch (error) {
    setSystemStatus('error', error.message);
  }
}

async function runAction(name, payload = {}) {
  try {
    const result = await postJson(`/api/actions/${name}`, payload);
    renderAction(result.action);
    await loadScan();
  } catch (error) {
    setSystemStatus('error', error.message);
    await loadScan({ refreshReadiness: true });
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAction('scan', { days: Number(elements.days.value), source: elements.source.value, open: elements.openAfter.checked });
});
elements.source.addEventListener('change', syncControls);
elements.refreshReadiness.addEventListener('click', () => loadScan({ refreshReadiness: true }));
elements.verify.addEventListener('click', () => runAction('verify-groups'));
elements.retryFailed.addEventListener('click', () => runAction('retry-failed'));
elements.markRead.addEventListener('click', () => runAction('mark-read'));
elements.openJobs.addEventListener('click', () => runAction('open-jobs'));
elements.processRecentBacklog.addEventListener('click', () => runAction('process-backlog', { days: 7 }));
elements.backlogGroups.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-group-toggle]');
  if (!toggle) return;
  const row = elements.backlogGroups.querySelector(`[data-group-details="${toggle.dataset.groupToggle}"]`);
  if (row) row.hidden = !row.hidden;
});
elements.requestHistory.addEventListener('click', async () => {
  try {
    await postJson('/api/whatsapp/history', {});
    await loadScan();
  } catch (error) {
    setSystemStatus('error', error.message);
  }
});

await loadScan();
startAdaptivePolling(loadScan, { isActive: () => actionRunning || historyRequestRunning });
