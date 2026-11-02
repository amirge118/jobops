// Applications become rows, and interview stories join the versioned documents.
export function up(db) {
  db.exec(`
    CREATE TABLE applications (
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      number           INTEGER NOT NULL,
      number_label     TEXT NOT NULL,
      applied_on       TEXT NOT NULL,
      company          TEXT NOT NULL,
      role             TEXT NOT NULL,
      company_role_key TEXT NOT NULL,
      score            TEXT NOT NULL,
      status           TEXT NOT NULL,
      pdf              TEXT NOT NULL,
      report           TEXT NOT NULL,
      notes            TEXT NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (user_id, number)
    );
    CREATE INDEX applications_identity_idx ON applications(user_id, company_role_key);

    CREATE TABLE profile_documents_next (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK(kind IN ('profile', 'resume', 'preferences', 'stories')),
      version      INTEGER NOT NULL,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, version)
    );
    INSERT INTO profile_documents_next SELECT * FROM profile_documents;
    DROP TABLE profile_documents;
    ALTER TABLE profile_documents_next RENAME TO profile_documents;
  `);
}
