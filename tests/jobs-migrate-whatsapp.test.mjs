import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { migrateWhatsAppState } from '../scripts/migrate-whatsapp-state.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

test('legacy WhatsApp migration copies dedup state into the unified store', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-wa-migration-test-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const legacyPath = path.join(tempDir, 'legacy.db');
  const jobsPath = path.join(tempDir, 'jobs.db');
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE processed_messages (
      message_id TEXT PRIMARY KEY, group_jid TEXT, wa_timestamp INTEGER, processed_at INTEGER
    );
    CREATE TABLE checkpoints (group_jid TEXT PRIMARY KEY, last_wa_timestamp INTEGER);
    INSERT INTO processed_messages VALUES ('old-message', 'group-a', 100, 200);
    INSERT INTO checkpoints VALUES ('group-a', 100);
  `);
  legacy.close();

  const result = migrateWhatsAppState({ legacyDatabasePath: legacyPath, jobsDatabasePath: jobsPath });
  assert.deepEqual(result, { messagesImported: 1, checkpointsSeen: 1 });

  const store = createJobStore(jobsPath);
  assert.equal(store.shouldProcessMessage('old-message'), false);
  assert.equal(store.getCheckpoint('whatsapp:group-a'), 100);
  store.close();
});
