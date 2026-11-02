// The groups the connected WhatsApp account belongs to, for the page's picker.
export function up(db) {
  db.exec(`
    CREATE TABLE whatsapp_known_groups (
      jid          TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      participants INTEGER,
      seen_at      INTEGER NOT NULL
    );
  `);
}
