// A verdict stays until its person asks to re-score it, since that spends their
// AI quota. Lives on jobs for now, and moves with verdicts when jobs is split.
export function up(db) {
  db.exec(`
    ALTER TABLE jobs ADD COLUMN rescore_requested_at INTEGER;
    CREATE INDEX jobs_rescore_requested_idx ON jobs(rescore_requested_at) WHERE rescore_requested_at IS NOT NULL;
  `);
}
