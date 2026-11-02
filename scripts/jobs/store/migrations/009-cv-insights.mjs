// What the AI said about a CV, kept per CV text and prompt version so an
// unchanged CV costs nothing. For display only: nothing that scores reads this.
export function up(db) {
  db.exec(`
    CREATE TABLE cv_insights (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK(kind IN ('analysis', 'facts')),
      resume_hash TEXT NOT NULL,
      version     TEXT NOT NULL,
      result      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, resume_hash, version)
    );
  `);
}
