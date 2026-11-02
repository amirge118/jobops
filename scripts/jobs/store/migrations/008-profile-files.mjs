// The CV file a person uploaded, next to the text read from it. text_hash is the
// resume document's hash at upload, to tell when that text was edited afterwards.
export function up(db) {
  db.exec(`
    CREATE TABLE profile_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name  TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      sha256     TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content    BLOB NOT NULL,
      text_hash  TEXT NOT NULL,
      identity   TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_profile_files_user ON profile_files(user_id, id);
  `);
}
