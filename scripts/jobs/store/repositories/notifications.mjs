export function createNotificationsRepository({ db, store, userId }) {
  return {
    async enqueueJobNotification({ jobKey, text, at = Date.now() }) {
      return (await db.prepare(`
        INSERT INTO notification_outbox (user_id, job_key, text, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, job_key) DO NOTHING
      `).run(userId, String(jobKey), String(text).slice(0, 2_000), Number(at))).changes === 1;
    },

    // Unsent, still-fresh notifications that have not exhausted their attempts.
    async listPendingNotifications({ now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, maxAttempts = 5, limit = 10 } = {}) {
      return await db.prepare(`
        SELECT id, job_key AS jobKey, text, attempts FROM notification_outbox
        WHERE user_id = ? AND sent_at IS NULL AND attempts < ? AND created_at >= ?
        ORDER BY created_at ASC LIMIT ?
      `).all(userId, Number(maxAttempts), Number(now) - Number(maxAgeMs), Math.max(1, Math.min(Number(limit) || 10, 50)));
    },

    async markNotificationSent(id, at = Date.now()) {
      await db.prepare('UPDATE notification_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE user_id = ? AND id = ?')
        .run(Number(at), userId, Number(id));
    },

    async markNotificationFailed(id, error) {
      await db.prepare('UPDATE notification_outbox SET attempts = attempts + 1, last_error = ? WHERE user_id = ? AND id = ?')
        .run(String(error || 'unknown').slice(0, 300), userId, Number(id));
    },

    // Health alerts share the job-notification outbox (the collector sends
    // it); the key keeps one alert per finding occurrence.
    async enqueueHealthNotification({ key, text, at = Date.now() }) {
      return await store.enqueueJobNotification({ jobKey: `health:${key}`, text, at });
    },
  };
}
