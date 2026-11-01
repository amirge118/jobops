// The local single user owns everything until accounts exist. Personal tables
// gain their user_id in later migrations.
export function up(db) {
  db.exec(`
    CREATE TABLE users (
      id           INTEGER PRIMARY KEY,
      display_name TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE user_settings (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);
  db.prepare('INSERT INTO users (id, created_at) VALUES (1, ?)').run(Date.now());
}
