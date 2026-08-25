#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { loadJobsConfig } from './jobs/config.mjs';
import { createJobStore } from './jobs/store.mjs';

function sourcePath(argv, rootDir) {
  const fromIndex = argv.indexOf('--from');
  const requested = fromIndex >= 0 ? argv[fromIndex + 1] : null;
  if (fromIndex >= 0 && !requested) throw new Error('--from requires a database path');
  return path.resolve(
    requested || path.join(rootDir, '..', 'whatsappJobsScanner', 'data', 'scanner.db'),
  );
}

export function migrateWhatsAppState({ legacyDatabasePath, jobsDatabasePath }) {
  if (!fs.existsSync(legacyDatabasePath)) {
    throw new Error(`Legacy WhatsApp database not found: ${legacyDatabasePath}`);
  }
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-wa-state-'));
  const snapshotPath = path.join(snapshotDir, 'scanner.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${legacyDatabasePath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${snapshotPath}${suffix}`);
  }
  let legacy = null;
  let store = null;
  try {
    legacy = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    store = createJobStore(jobsDatabasePath);
    const messages = legacy.prepare(`
      SELECT message_id, group_jid, wa_timestamp, processed_at
      FROM processed_messages
    `).all();
    const checkpoints = legacy.prepare(`
      SELECT group_jid, last_wa_timestamp
      FROM checkpoints
    `).all();
    return store.importWhatsAppState({ messages, checkpoints });
  } finally {
    legacy?.close();
    store?.close();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const config = loadJobsConfig();
  const legacyDatabasePath = sourcePath(argv, config.rootDir);
  const result = migrateWhatsAppState({
    legacyDatabasePath,
    jobsDatabasePath: config.jobsDbPath,
  });
  console.log(`יובאו ${result.messagesImported} הודעות WhatsApp חדשות למנגנון ה-dedup.`);
  console.log(`נבדקו ${result.checkpointsSeen} checkpoints; מצב חדש יותר לא הוחלף.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`ייבוא מצב WhatsApp נכשל: ${error.message}`);
    process.exitCode = 1;
  }
}
