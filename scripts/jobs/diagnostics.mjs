// Durable diagnostics contain an allowlisted explanation, never a raw exception,
// message body, URL query, QR code or subprocess transcript.
const reasons = {
  permission_denied: ['מערכת ההפעלה חסמה גישה לקובץ או לתיקייה.', 'בדוק הרשאות לתיקיית הפרויקט והרשאות Documents לתוכנה שמפעילה אותו.'],
  timeout: ['הפעולה לא קיבלה תשובה בזמן שהוקצב לה.', 'בדוק חיבור ונסה שוב; כשל חוזר באותו מקור עשוי להעיד על חסימה או שירות איטי.'],
  network_error: ['החיבור לשירות נכשל או נותק.', 'בדוק רשת וזמינות של המקור, ואז נסה שוב.'],
  authentication_required: ['השירות דחה את האימות או דרש התחברות.', 'בדוק את החיבור לשירות שנכשל: WhatsApp או Codex, לפי השלב.'],
  rate_limited: ['השירות הגביל את קצב הבקשות או את המכסה.', 'המתן לפני ניסיון חוזר ובדוק את המכסה בשירות.'],
  http_error: ['האתר החזיר קוד HTTP של שגיאה.', 'בדוק את קוד התשובה ופתח ידנית את הקישור המקורי; אין להסיק שהמשרה לא מתאימה.'],
  browser_error: ['הדפדפן האוטומטי לא הצליח לפתוח או לקרוא את העמוד.', 'פתח את הקישור ידנית ובדוק אם נדרשת התחברות או שהאתר חוסם אוטומציה.'],
  scoring_failed: ['עיבוד ההתאמה לא הושלם או החזיר תשובה לא תקינה.', 'בדוק את התחברות Codex ונסה שוב דרך ניסיון חוזר לקישורים שנכשלו.'],
  codex_usage_limit: ['הגעת למכסת השימוש הזמנית ב-Codex/ChatGPT.', 'המתן לזמן האיפוס שמופיע בהודעת המכסה ונסה שוב; המשרות שנכשלו ינוסו שוב אוטומטית בסריקה הבאה, אין צורך בפעולה ידנית.'],
  page_uncertain: ['לא התקבל תוכן מספיק כדי לאמת את עמוד המשרה.', 'פתח את הקישור ידנית; המשרה לא סומנה כלא מתאימה בגלל כשל הקריאה.'],
  collection_failed: ['איסוף הנתונים מהמקור לא הושלם.', 'בדוק את המקור או הקבוצה המצוינים באירוע ונסה שוב.'],
  invalid_link: ['נמצא קישור שאינו כתובת תקינה לעיבוד.', 'בדוק את כתובת המשרה במקור; הכשל אינו החלטת התאמה.'],
  group_unavailable: ['הקבוצה המוגדרת לא נמצאה בחשבון המחובר.', 'ודא שחיברת את חשבון WhatsApp הנכון ושהקבוצה עדיין קיימת בהגדרות.'],
  coverage_incomplete: ['WhatsApp לא סיפק הוכחה שכל חלון הזמן התקבל.', 'בדוק חיבור וסנכרון; אפס הודעות שהתקבלו אינו אומר שאין הודעות בקבוצה.'],
  history_not_delivered: ['החיבור הקיים דיווח על סנכרון קודם, אך לא מסר הודעות או עוגן היסטוריה בקבוצות.', 'בדוק את סנכרון המכשיר המקושר; ייתכן שנדרש קישור מחדש. אין להסיק שאין הודעות.'],
  missing_anchor: ['לא התקבלה הודעה אמיתית שממנה אפשר לבקש היסטוריה, גם אחרי ההמתנה.', 'בדוק סנכרון במכשיר המקושר ונסה שוב כשמגיעה הודעה לקבוצה. אין צורך למחוק את החיבור אוטומטית.'],
  anchor_too_old: ['העוגן השמור ישן מחלון הסריקה ולא התקבלה נקודת התחלה חדשה.', 'בקשה ממנו תחזיר רק הודעות ישנות יותר. נדרשת הודעה עדכנית מהקבוצה או חידוש הסנכרון.'],
  newer_messages_unverified: ['נאספו הודעות, אבל אין הוכחה שהן מגיעות עד סוף חלון הסריקה.', 'בדוק את הזמן האחרון שהתקבל. אין להסיק שההודעות החדשות יותר נבדקו.'],
  history_no_response: ['נשלחה בקשת היסטוריה אך לא התקבלה מנת היסטוריה בזמן ההמתנה.', 'בדוק חיבור בטלפון ובמכשיר המקושר, ואז נסה שוב. אישור הבקשה אינו אישור קבלת התוכן.'],
  history_no_progress: ['התקבלו הודעות אך לא הושגה התקדמות אחורה בהיסטוריה.', 'הסריקה נעצרה כדי לא לחזור על אותה בקשה. נסה שוב אחרי סנכרון.'],
  history_request_timeout: ['בקשת ההיסטוריה לא הסתיימה בזמן שהוקצב לה.', 'בדוק חיבור בטלפון ונסה שוב. הקבוצה לא נספרה כסריקה מלאה.'],
  history_request_failed: ['WhatsApp דחה את בקשת ההיסטוריה או שהחיבור נכשל.', 'בדוק את חיבור המכשיר המקושר ונסה שוב; לא נקבע שאין הודעות בקבוצה.'],
  history_deadline: ['הושגה מגבלת הזמן להשלמת ההיסטוריה.', 'המידע שהתקבל נשמר. נסה חלון קצר יותר או ניסיון נוסף.'],
  history_batch_limit: ['הושגה מגבלת 20 בקשות היסטוריה לקבוצה.', 'בדוק את הכיסוי שהושג והמשך עם חלון קצר יותר.'],
  history_boundary_missing: ['ההודעות שהתקבלו לא מגיעות לתחילת חלון הסריקה.', 'הסריקה חלקית; נסה שוב או בחר חלון קצר יותר.'],
  read_failed: ['לא אושר משלוח סימון הקריאה לקבוצה.', 'בדוק חיבור ונסה שוב את פעולת סימון הקבוצות כנקראו.'],
  collector_already_running: ['כבר פועל תהליך WhatsApp Collector שמשתמש באותו חיבור.', 'אין להפעיל חיבור נוסף. בדוק את מצב ה-Collector והשתמש בריצה הקיימת.'],
  collector_offline: ['ה-WhatsApp Collector אינו מחובר כרגע.', 'הפעל את ה-Collector ובדוק את אירוע החיבור האחרון לפני סריקה נוספת.'],
  collector_gap: ['ה-Collector לא היה מחובר במשך כל חלון הזמן שהתבקש.', 'הודעות שנקלטו יעובדו, אבל אין הוכחה שכל ההודעות בחלון התקבלו. השאר את ה-Collector פעיל להבא.'],
  pairing_required: ['חיבור WhatsApp דורש קישור מחדש באמצעות QR.', 'הפעל את ה-Collector ידנית, סרוק QR פעם אחת והשאר את המחשב והטלפון מחוברים.'],
  decrypt_failed: ['WhatsApp מסר הודעה שלא ניתן היה לפענח באמצעות מצב ההתחברות הקיים.', 'בדוק את ציר הזמן של ה-Collector. אם הכשל חוזר ברצף, בצע קישור מחדש מבוקר במקום למחוק auth אוטומטית.'],
  connection_replaced: ['WhatsApp החליף או סגר את החיבור בגלל חיבור פעיל אחר.', 'ודא שפועל רק Collector אחד ושאין סורק נוסף המשתמש באותה תיקיית auth.'],
  process_interrupted: ['התהליך הופסק לפני סיום הריצה.', 'השלב האחרון נשמר. אפשר לנסות שוב; עבודות שכבר עובדו נשמרו.'],
  process_missing: ['התהליך שתועד אינו פועל, ולא נשמר אירוע סיום. סיבת העצירה אינה ידועה.', 'בדוק אם הטרמינל נסגר או המחשב הופעל מחדש; נסה שוב מהשלב שנכשל.'],
  legacy_unknown: ['בריצה הישנה לא תועד תהליך או אירוע סיום, ולכן אי אפשר לקבוע מה קרה.', 'אין אפשרות לשחזר את הסיבה בדיעבד. הריצות החדשות כוללות תיעוד של שלבים וכשלים.'],
  heartbeat_stale: ['לא התקבל עדכון חיים במשך יותר מדקה; אין הוכחה שהתהליך נעצר.', 'בדוק אם התהליך ממתין או תקוע לפני הפעלת סריקה נוספת.'],
  command_failed: ['הפקודה הסתיימה בכשל ללא סיבה מפורטת מזוהה.', 'בדוק את השלב האחרון ואת קוד היציאה; אם הכשל חוזר, שתף את פרטי האבחון.'],
  unknown_failure: ['התרחש כשל שלא סווג. הסיבה המדויקת אינה ידועה.', 'שתף את מזהה הריצה, השלב ומיקום הקוד אם מוצג; אין צורך לשתף פרטי חיבור.'],
};

export function describeFailure(error, fallback = 'unknown_failure') {
  const message = `${error?.code || ''} ${error?.message ?? error ?? ''}`.slice(0, 16_384);
  let code = Object.hasOwn(reasons, fallback) ? fallback : 'unknown_failure';
  const httpStatus = Number(message.match(/(?:http[ _:]*(?:status[ :]*|error[ :]*|returned[ :]*)?|status code[ :]*)([45]\d\d)\b/i)?.[1]) || null;
  if (/\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i.test(message)) code = 'permission_denied';
  else if (/collector.+already running|lock.+already held|EEXIST.+whatsapp/i.test(message)) code = 'collector_already_running';
  else if (/bad mac|failed to decrypt|decrypt.+failed|no session found/i.test(message)) code = 'decrypt_failed';
  else if (/connection replaced|status\s*440/i.test(message)) code = 'connection_replaced';
  else if (/pairing required|scan.+qr|logged.?out/i.test(message)) code = 'pairing_required';
  else if (/ERR_INVALID_URL|invalid url/i.test(message)) code = 'invalid_link';
  else if (/usage limit|purchase more credits|hit your usage/i.test(message)) code = 'codex_usage_limit';
  else if (httpStatus === 429 || /rate.limit|quota/i.test(message)) code = 'rate_limited';
  else if (httpStatus === 401 || /unauthori[sz]ed|logged.out|not authenticated|authentication required/i.test(message)) code = 'authentication_required';
  else if (/timeout|timed out|AbortError|ETIMEDOUT/i.test(message)) code = 'timeout';
  else if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|connection closed/i.test(message)) code = 'network_error';
  else if (httpStatus) code = 'http_error';
  const [reason, nextStep] = reasons[code];
  // Keep only a repository-relative code location, not arbitrary stack content.
  const location = String(error?.stack || '').match(/\/(scripts\/(?:jobs\/(?:sources\/)?|providers\/)?[a-z0-9-]+\.mjs:\d+:\d+)\)?/i)?.[1] || null;
  return { code, reason, nextStep, ...(httpStatus ? { httpStatus } : {}), ...(location ? { location } : {}) };
}

export function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

// Observation only: never rewrite old runs or label an unproven exit as success.
export function observedRun(row, { probe = processState, now = Date.now() } = {}) {
  if (!row || row.status !== 'running') return row;
  let code;
  if (!row.owner_pid) code = 'legacy_unknown';
  else if (probe(row.owner_pid) === 'dead') code = 'process_missing';
  else if (now - row.heartbeat_at > 60_000) code = 'heartbeat_stale';
  if (!code) return row;
  return { ...row, recordedStatus: row.status, status: code === 'process_missing' ? 'interrupted' : 'unconfirmed', diagnostic: describeFailure(null, code) };
}

export function safeTargetUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.hostname : null;
  } catch { return null; }
}

// Inspect bounded complete lines only. Unknown output is intentionally not saved.
// Matching a category emits static text; even a line containing a secret cannot
// place that secret in history. QR codes remain in the live output only.
export function createFailureCollector(onFailure) {
  const buffers = new Map();
  const seen = new Set();
  function line(value) {
    const failure = describeFailure(value);
    const key = `${failure.code}:${failure.httpStatus || ''}`;
    if (failure.code === 'unknown_failure' || seen.has(key)) return;
    seen.add(key);
    onFailure(failure);
  }
  return {
    push(chunk, stream = 'stdout') {
      const parts = `${buffers.get(stream) || ''}${String(chunk)}`.split(/\r?\n/);
      buffers.set(stream, parts.pop().slice(-16_384));
      for (const part of parts) line(part.slice(0, 16_384));
    },
    flush() { for (const value of buffers.values()) line(value); buffers.clear(); },
  };
}

export function createRunLifecycle(store, runId, { registerProcessHandlers = false } = {}) {
  let ended = false;
  let stage = 'setup';
  let source = 'system';
  const heartbeat = setInterval(() => store.touchRun(runId), 5_000);
  heartbeat.unref();
  const lifecycle = {
    stage(next, nextSource = 'system') {
      stage = next;
      source = nextSource;
      store.touchRun(runId, { stage });
      store.recordRunEvent(runId, { source, scope: 'run', stage, status: 'started' });
    },
    finish(status, { failure = null, details = null } = {}) {
      if (ended) return;
      store.recordRunEvent(runId, { source, scope: 'run', stage, status, details: failure });
      store.finishRun(runId, { status, error: failure?.reason, details, failure });
      ended = true;
    },
    dispose() {
      clearInterval(heartbeat);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
  const emergencyFinish = (status, failure) => {
    try { lifecycle.finish(status, { failure }); }
    catch { console.error('JobOps diagnostic storage unavailable; check permissions and disk space.'); }
  };
  const handlers = registerProcessHandlers ? [
    ...['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
      emergencyFinish('interrupted', { ...describeFailure(null, 'process_interrupted'), signal });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }]),
    ['uncaughtExceptionMonitor', (error) => emergencyFinish('failed', describeFailure(error))],
    ['exit', (exitCode) => emergencyFinish('interrupted', { ...describeFailure(null, 'process_interrupted'), exitCode })],
  ] : [];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return lifecycle;
}
