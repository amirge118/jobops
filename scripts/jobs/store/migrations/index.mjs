import { up as baseline } from './001-baseline.mjs';
import { up as users } from './002-users.mjs';
import { up as profileDocuments } from './003-profile-documents.mjs';
import { up as rescoreRequests } from './004-rescore-requests.mjs';
import { up as knownGroups } from './005-known-whatsapp-groups.mjs';
import { up as applications } from './006-applications-and-stories.mjs';
import { up as userOwnedTables } from './007-user-owned-tables.mjs';

// Append-only: a shipped migration never changes, and each runs once per
// database. A schema or data change is a new entry here, including a new
// decision key, which job_decisions' CHECK list must be widened for.
export const MIGRATIONS = Object.freeze([
  { version: 1, name: 'baseline', up: baseline },
  { version: 2, name: 'users', up: users },
  { version: 3, name: 'profile_documents', up: profileDocuments },
  { version: 4, name: 'rescore_requests', up: rescoreRequests },
  { version: 5, name: 'known_whatsapp_groups', up: knownGroups },
  { version: 6, name: 'applications_and_stories', up: applications },
  { version: 7, name: 'user_owned_tables', up: userOwnedTables },
]);

export function runMigrations(db, migrations = MIGRATIONS) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedVersion = () => db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
  const latest = Math.max(0, ...migrations.map((migration) => migration.version));
  if (appliedVersion() >= latest) return;

  // IMMEDIATE takes the write lock first, so of several processes starting
  // together one migrates and the others see it done.
  db.transaction(() => {
    const current = appliedVersion();
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
    }
  }).immediate();
}
