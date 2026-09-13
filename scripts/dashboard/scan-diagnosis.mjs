function countFailure(details, code) {
  return Number(details?.processing?.totals?.failureReasons?.[code] || 0);
}

function uniqueCodes(items) {
  return [...new Set(items.filter(Boolean))];
}

export function buildScanDiagnosis({ lastRun, readiness = {} } = {}) {
  if (!lastRun) {
    return {
      status: 'empty',
      title: 'עדיין לא בוצעה סריקה',
      summary: 'בדיקת המוכנות תראה אם אפשר להתחיל.',
      issues: [],
      technical: { runId: null, codes: [] },
    };
  }

  const details = lastRun.details || {};
  const totals = details.processing?.totals || {};
  const links = Number(totals.links || 0);
  const processed = Number(totals.processed || 0);
  const failed = Number(totals.failed || 0);
  const browserFailures = countFailure(details, 'browser_error');
  const scoringFailures = countFailure(details, 'scoring_failed');
  const groups = details.whatsapp?.groups || [];
  const failedGroups = groups.filter((group) => group.error || !['complete', 'partial'].includes(group.coverage?.status));
  const status = lastRun.status === 'success' && failed === 0 && !details.whatsapp?.warning ? 'success'
    : lastRun.status === 'failed' ? 'failed' : 'incomplete';
  const title = status === 'success' ? 'הסריקה הסתיימה בהצלחה'
    : status === 'failed' ? 'הסריקה נכשלה' : 'הסריקה הסתיימה חלקית';
  const summary = status === 'success'
    ? `${processed} מתוך ${links} קישורים עובדו ללא כשל.`
    : `${processed} מתוך ${links} קישורים עובדו; ${failed} נכשלו ודורשים טיפול.`;
  const issues = [];

  if ((browserFailures || scoringFailures) &&
      [readiness.browser?.code, readiness.scorer?.code].includes('sandboxed_runtime')) {
    issues.push({
      code: 'sandboxed_runtime',
      title: 'האתר הופעל מסביבה שמגבילה את הסורק',
      reason: `${browserFailures} קישורים לא נפתחו ו-${scoringFailures} משרות לא קיבלו ציון בגלל מגבלות ההפעלה.`,
      nextStep: readiness.browser?.nextStep || readiness.scorer?.nextStep,
      action: 'relaunch',
    });
  } else {
    if (browserFailures) issues.push({
      code: 'browser_unavailable', title: 'פתיחת עמודי המשרות נכשלה',
      reason: `${browserFailures} קישורים לא נפתחו בדפדפן האוטומטי.`,
      nextStep: readiness.browser?.nextStep || 'בדוק את התקנת Chromium ונסה שוב.', action: 'retry',
    });
    if (scoringFailures) issues.push({
      code: 'scoring_failed', title: 'בדיקת ההתאמה לא הסתיימה',
      reason: `${scoringFailures} משרות לא קיבלו ציון.`,
      nextStep: readiness.scorer?.nextStep || 'בדוק את התחברות Codex ונסה שוב.', action: 'retry',
    });
  }

  if (failedGroups.length && readiness.collector?.status === 'blocked') {
    issues.push({
      code: readiness.collector.code || 'collector_offline',
      title: 'WhatsApp לא סיפק כיסוי אמין',
      reason: `${failedGroups.length} מתוך ${groups.length} קבוצות לא סיפקו את חלון ההודעות המבוקש.`,
      nextStep: readiness.collector.nextStep,
      action: 'collector',
    });
  } else if (failedGroups.length) {
    issues.push({
      code: 'whatsapp_coverage_incomplete', title: 'כיסוי WhatsApp חלקי',
      reason: `${failedGroups.length} מתוך ${groups.length} קבוצות לא סיפקו כיסוי מלא.`,
      nextStep: 'בדוק שה-Collector מחובר והמתן לסנכרון לפני ניסיון נוסף.', action: 'readiness',
    });
  }

  const codes = uniqueCodes([
    ...issues.map((issue) => issue.code),
    ...Object.keys(totals.failureReasons || {}),
    ...failedGroups.map((group) => group.coverage?.reason),
    lastRun.diagnostic?.code,
  ]);
  return { status, title, summary, issues, technical: { runId: Number(lastRun.id), codes } };
}
