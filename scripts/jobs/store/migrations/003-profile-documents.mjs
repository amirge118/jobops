// A person's CV, full profile and preferences as text, one row per saved version.
export function up(db) {
  db.exec(`
    CREATE TABLE profile_documents (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK(kind IN ('profile', 'resume', 'preferences')),
      version      INTEGER NOT NULL,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, version)
    );

    -- Maps a scoring hash to the one existing verdicts were stamped with, so
    -- moving to documents does not make every scored job look out of date.
    CREATE TABLE scoring_hash_aliases (
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      canonical_hash TEXT NOT NULL,
      stored_hash    TEXT NOT NULL,
      PRIMARY KEY (user_id, canonical_hash)
    );

    -- What was last written to profile/*.md, to tell a hand edit from our own.
    CREATE TABLE profile_file_exports (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
  `);
}
