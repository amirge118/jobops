// alerted_at lets an alert wait for a later check instead of going out when a
// finding opens; open findings were already alerted. failed_streak counts a
// search's failed attempts in a row; a last failure counts as the first.
export function up(db) {
  db.exec(`
    ALTER TABLE health_findings ADD COLUMN alerted_at INTEGER;
    UPDATE health_findings SET alerted_at = first_seen_at;
    ALTER TABLE linkedin_search_progress ADD COLUMN failed_streak INTEGER NOT NULL DEFAULT 0;
    UPDATE linkedin_search_progress SET failed_streak = 1 WHERE last_status = 'failed';
  `);
}
