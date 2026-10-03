// Notifications about strong new jobs. A scan run only queues them in the
// store (notification_outbox); the WhatsApp collector sends them to the
// person's own number, since it owns the only WhatsApp connection.

const DEFAULTS = Object.freeze({ enabled: false, minScore: 4, dashboardUrl: 'http://127.0.0.1:4177/decisions' });

export function notificationSettings(config) {
  const settings = { ...DEFAULTS, ...(config?.notifications?.whatsapp || {}) };
  return { ...settings, enabled: Boolean(settings.enabled), minScore: Number(settings.minScore) };
}

export function formatJobNotification(job, { dashboardUrl = DEFAULTS.dashboardUrl } = {}) {
  const score = Number.isFinite(Number(job.score)) ? Number(job.score).toFixed(1) : '—';
  return [
    `🟢 משרה חדשה (${score}): ${job.company || 'חברה לא ידועה'} — ${job.title || 'ללא כותרת'}`,
    job.applyUrl,
    `להחלטה: ${dashboardUrl}`,
  ].filter(Boolean).join('\n');
}

// Returns how many were newly queued; a job already queued is skipped.
export function queueJobNotifications({ store, jobs, config, now = Date.now() }) {
  const settings = notificationSettings(config);
  if (!settings.enabled) return 0;
  let queued = 0;
  for (const job of jobs) {
    if (!(Number(job.score) >= settings.minScore)) continue;
    if (store.enqueueJobNotification({ jobKey: job.jobKey, text: formatJobNotification(job, settings), at: now })) queued += 1;
  }
  return queued;
}

// Called from the collector's connected loop. Sends to the account's own
// chat ("Message yourself"); never to anyone else.
export async function sendPendingNotifications({ store, sock, ownJid, now = Date.now }) {
  if (!ownJid) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const item of store.listPendingNotifications({ now: now() })) {
    try {
      await sock.sendMessage(ownJid, { text: item.text });
      store.markNotificationSent(item.id, now());
      sent += 1;
    } catch (error) {
      store.markNotificationFailed(item.id, error?.message);
      failed += 1;
    }
  }
  return { sent, failed };
}
