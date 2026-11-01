// What a person decided, learned and receives belongs to that person. Every
// existing row belongs to the local user, who is user 1.
const USER_COLUMN = 'user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE';

function rebuild(db, table, { from, to, tail = '', indexes = [] }) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name).join(', ');
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (!from.test(sql)) throw new Error(`Unexpected schema for ${table}`);
  const body = sql.slice(open + 1, close).replace(from, to).trimEnd();
  db.exec(`
    CREATE TABLE ${table}_next (${USER_COLUMN},${body}${tail});
    INSERT INTO ${table}_next (${columns}) SELECT ${columns} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_next RENAME TO ${table};
    ${indexes.join('\n')}
  `);
}

const keyedBy = (column) => ({
  from: new RegExp(`${column}\\s+TEXT PRIMARY KEY`),
  to: `${column} TEXT NOT NULL`,
  tail: `,\n      PRIMARY KEY (user_id, ${column})`,
});

export function up(db) {
  rebuild(db, 'job_decisions', { ...keyedBy('job_key'), indexes: ['CREATE INDEX job_decisions_decided_idx ON job_decisions(user_id, decided_at);'] });
  rebuild(db, 'blocked_companies', keyedBy('company_key'));
  rebuild(db, 'gap_observations', keyedBy('job_key'));
  rebuild(db, 'gap_term_statuses', keyedBy('term_key'));
  rebuild(db, 'weekly_reports', keyedBy('week_start'));
  rebuild(db, 'gap_term_coverage', { from: /PRIMARY KEY \(coverage_key, term_key\)/, to: 'PRIMARY KEY (user_id, coverage_key, term_key)' });
  rebuild(db, 'notification_outbox', { from: /job_key\s+TEXT NOT NULL UNIQUE/, to: 'job_key TEXT NOT NULL', tail: ',\n      UNIQUE (user_id, job_key)' });
}
