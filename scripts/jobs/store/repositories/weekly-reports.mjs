export function createWeeklyReportsRepository({ db }) {
  return {
    // A block stops every LinkedIn request; recent activity (another run's
    // searches or page reads) only spaces out page reads, so frequent
    // WhatsApp runs can never starve the scheduled LinkedIn scan.
    async saveWeeklyReport({ weekStart, snapshot, analysis = null, status, at = Date.now() }) {
      await db.prepare(`
        INSERT INTO weekly_reports (week_start, snapshot_json, analysis_json, status, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(week_start) DO UPDATE SET
          snapshot_json = excluded.snapshot_json, analysis_json = excluded.analysis_json,
          status = excluded.status, created_at = excluded.created_at
      `).run(String(weekStart), JSON.stringify(snapshot), analysis == null ? null : JSON.stringify(analysis), status, Number(at));
    },

    // The newest report, or the newest one before `before` (a week_start).
    async getWeeklyReport({ before = null } = {}) {
      const row = before
        ? await db.prepare('SELECT * FROM weekly_reports WHERE week_start < ? ORDER BY week_start DESC LIMIT 1').get(String(before))
        : await db.prepare('SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT 1').get();
      if (!row) return null;
      return {
        weekStart: row.week_start, status: row.status, createdAt: row.created_at, sentAt: row.sent_at,
        snapshot: JSON.parse(row.snapshot_json), analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null,
      };
    },

    async markWeeklyReportSent(weekStart, at = Date.now()) {
      await db.prepare('UPDATE weekly_reports SET sent_at = ? WHERE week_start = ?').run(Number(at), String(weekStart));
    },
  };
}
