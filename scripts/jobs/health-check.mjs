// Scheduled, token-free check for problems that need attention: recurring
// failures, stuck state, and limits. One-off failures that later runs
// recover from are deliberately not findings. evaluateHealth is pure (facts
// in, findings out); runHealthCheck stores them and alerts on new ones.

import { NON_RETRYABLE_FAILURE_CODES } from '../liveness-browser.mjs';
import { notificationSettings } from './notifications.mjs';

const HOUR = 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Jerusalem';

export const HEALTH_THRESHOLDS = Object.freeze({
  companyFailedRuns: 3, // the same ATS company failing in this many runs within 24h
  atsStaleHours: 3, // ATS runs hourly 08-21
  linkedinStaleHours: 5, // LinkedIn runs every 2 hours 08-22
  linkedinFailedHours: 12, // an enabled search without success for this long
  codexMinCalls: 5,
  codexFailureRate: 0.3,
  codexConsecutiveFailures: 3,
  collectorReconnectsPerHour: 3,
  backlogWaitHours: 24,
  retryStuckHours: 24,
});

function israelHour(ms) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(ms));
}

function hoursAgo(now, at) {
  return Math.round((now - Number(at)) / HOUR);
}

function timeText(ms) {
  return new Date(Number(ms)).toLocaleString('he-IL', { timeZone: TIME_ZONE, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A scheduled source is late only inside the hours its schedule runs, plus
// the grace period; overnight silence is expected.
function staleScheduledRun(facts, source, { staleHours, activeFrom, activeTo }) {
  const hour = israelHour(facts.now);
  if (hour < activeFrom || hour > activeTo) return null;
  const last = facts.lastRuns?.[source];
  const lastAt = Number(last?.finishedAt || 0);
  return facts.now - lastAt > staleHours * HOUR ? { lastAt } : null;
}

export function evaluateHealth(facts, thresholds = HEALTH_THRESHOLDS) {
  const findings = [];
  const add = (key, area, severity, title, detail) => findings.push({ key, area, severity, title, detail });
  const { now } = facts;

  for (const failure of facts.companyFailures || []) {
    if (failure.runs < thresholds.companyFailedRuns) continue;
    add(`ats-company:${failure.company}`, 'ats', 'warn', `החברה ${failure.company} נכשלת שוב ושוב בסריקת ATS`,
      `נכשלה ב-${failure.runs} ריצות ב-24 השעות האחרונות (${failure.code || 'ללא קוד'}). בדוק את מקור המשרות שלה בעמוד החברות.`);
  }

  const atsStale = staleScheduledRun(facts, 'ats', { staleHours: thresholds.atsStaleHours, activeFrom: 8 + thresholds.atsStaleHours, activeTo: 23 });
  if (atsStale) {
    add('stale:ats', 'ats', 'error', 'סריקת ATS המתוזמנת לא רצה',
      atsStale.lastAt ? `הריצה האחרונה הסתיימה ב-${timeText(atsStale.lastAt)}. בדוק npm run jobs:schedule:status.` : 'אין אף ריצת ATS שהסתיימה.');
  }
  const linkedinStale = staleScheduledRun(facts, 'linkedin', { staleHours: thresholds.linkedinStaleHours, activeFrom: 8 + thresholds.linkedinStaleHours, activeTo: 23 });
  if (linkedinStale && (facts.linkedinSearches || []).length > 0 && !(Number(facts.linkedinBlockedUntil) > now)) {
    add('stale:linkedin', 'linkedin', 'warn', 'סריקת LinkedIn המתוזמנת לא רצה',
      linkedinStale.lastAt ? `הריצה האחרונה הסתיימה ב-${timeText(linkedinStale.lastAt)}.` : 'אין אף ריצת LinkedIn שהסתיימה.');
  }

  for (const run of facts.stuckRuns || []) {
    add(`stuck-run:${run.id}`, 'runs', 'error', `ריצה ${run.id} תקועה בשלב ${run.stage || 'לא ידוע'}`,
      `לא דווח דופק מאז ${timeText(run.heartbeatAt || run.startedAt)}; התהליך כנראה נפל. היא חוסמת סריקות שממתינות לנעילה.`);
  }

  const calls = facts.codexCalls || [];
  const failed = calls.filter((call) => !call.ok);
  const lastReason = failed.find((call) => call.errorReason)?.errorReason;
  const reasonText = lastReason ? ` השגיאה האחרונה: ${lastReason}` : '';
  const leadingFailures = calls.findIndex((call) => call.ok);
  const consecutive = leadingFailures === -1 ? calls.length : leadingFailures;
  if (Number(facts.llmBlockedUntil) > now) {
    add('codex:blocked', 'codex', 'error', 'מכסת Codex נגמרה', `ניקוד משרות מושהה עד ${timeText(facts.llmBlockedUntil)}.`);
  } else if (consecutive >= thresholds.codexConsecutiveFailures) {
    add('codex:consecutive', 'codex', 'error', `${consecutive} קריאות Codex אחרונות נכשלו ברצף`, `משרות חדשות לא מנוקדות.${reasonText}`);
  } else if (calls.length >= thresholds.codexMinCalls && failed.length / calls.length >= thresholds.codexFailureRate) {
    add('codex:rate', 'codex', 'warn', `${failed.length} מתוך ${calls.length} קריאות Codex נכשלו ב-24 שעות`, `שיעור כישלון גבוה.${reasonText}`);
  }

  for (const search of facts.linkedinSearches || []) {
    if (search.lastStatus !== 'failed') continue;
    const since = Number(search.lastSuccessAt || 0);
    if (now - since < thresholds.linkedinFailedHours * HOUR) continue;
    add(`linkedin-search:${search.key}`, 'linkedin', 'warn', `חיפוש LinkedIn "${search.key}" נכשל`,
      `${search.lastReason || 'ללא סיבה'}; ${since ? `אין הצלחה מאז ${timeText(since)}` : 'אף פעם לא הצליח'}.`);
  }

  const collector = facts.collector;
  if (!collector || ['interrupted', 'unconfirmed', 'stopped', 'failed', 'pairing_required'].includes(collector.status)) {
    add('whatsapp:collector', 'whatsapp', 'error', 'אוסף ה-WhatsApp לא מחובר',
      collector ? `מצב: ${collector.status}. הודעות מהקבוצות לא נאספות. הרץ npm run restart:local.` : 'האוסף מעולם לא רץ.');
  } else if (collector.status === 'connected') {
    const hours = Math.max(1, (now - Number(collector.started_at)) / HOUR);
    const perHour = Number(collector.reconnects || 0) / hours;
    if (hours >= 3 && perHour > thresholds.collectorReconnectsPerHour) {
      add('whatsapp:reconnects', 'whatsapp', 'warn', 'החיבור ל-WhatsApp מתנתק לעתים קרובות',
        `${collector.reconnects} התחברויות מחדש ב-${Math.round(hours)} שעות. הודעות עלולות להתעכב.`);
    }
  }

  if (facts.oldestPendingMessageAt && now - Number(facts.oldestPendingMessageAt) > thresholds.backlogWaitHours * HOUR) {
    add('whatsapp:backlog', 'whatsapp', 'warn', 'הודעות WhatsApp ממתינות לעיבוד יותר מיממה',
      `הוותיקה ביותר מ-${timeText(facts.oldestPendingMessageAt)}. בדוק שבודק ה-backlog (whatsapp-trigger) רץ.`);
  }

  const stuckRetries = (facts.failedJobs || []).filter((group) => !NON_RETRYABLE_FAILURE_CODES.has(group.code)
    && now - Number(group.oldestAttemptAt || now) > thresholds.retryStuckHours * HOUR);
  if (stuckRetries.length) {
    const count = stuckRetries.reduce((sum, group) => sum + group.count, 0);
    add('jobs:stuck-retries', 'jobs', 'warn', `${count} משרות נכשלו ולא נוסו שוב יותר מיממה`,
      `קודים: ${stuckRetries.map((group) => `${group.code} (${group.count})`).join(', ')}. ניסיון חוזר מעמוד הסריקה.`);
  }

  if (Number(facts.resumeGapFailures) > 0) {
    add('jobs:resume-gap', 'jobs', 'info', `ניתוח קורות החיים נכשל ל-${facts.resumeGapFailures} משרות`, 'ינוסה שוב בסריקה הבאה.');
  }

  return findings;
}

export function formatHealthAlert(findings, { dashboardUrl }) {
  const base = String(dashboardUrl || '').replace(/\/[^/]*$/, '') || 'http://127.0.0.1:4177';
  return [
    `⚠️ jobOps: ${findings.length === 1 ? 'בעיה חדשה' : `${findings.length} בעיות חדשות`}`,
    ...findings.map((finding) => `• ${finding.title}`),
    `לפרטים: ${base}/scan`,
  ].join('\n');
}

// Stores the findings and queues one WhatsApp alert for those that are new
// and worth interrupting for (error / warn). Info findings only show on the page.
export function runHealthCheck({ store, config, now = Date.now(), notify = true }) {
  const findings = evaluateHealth(store.listHealthFacts({ now }));
  const opened = store.saveHealthFindings(findings, now);
  const alerting = opened.filter((finding) => finding.severity !== 'info');
  const settings = notificationSettings(config);
  let alerted = false;
  if (notify && settings.enabled && alerting.length) {
    alerted = store.enqueueHealthNotification({
      key: `${now}:${alerting.map((finding) => finding.key).join(',')}`.slice(0, 200),
      text: formatHealthAlert(alerting, settings),
      at: now,
    });
  }
  return { findings, opened, alerted };
}
