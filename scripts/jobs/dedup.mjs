#!/usr/bin/env node

// One-off cleanup for jobs stored before cross-source dedup: groups rows that
// share a company + role, keeps one representative per group and marks the
// rest duplicate_of it. Dry run by default; --apply writes.
//   npm run jobs:dedup [-- --apply] [--db path/to/jobs.db]

import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';

function describe(row) {
  const state = row.archived_at ? 'archived'
    : !row.evaluated_at ? 'pending'
      : row.suitable ? 'suitable' : 'rejected';
  return `${state.padEnd(8)} ${row.canonical_url}`;
}

export function runDedup(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const dbIndex = argv.indexOf('--db');
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : loadJobsConfig().jobsDbPath;
  if (!dbPath) throw new Error('Use: npm run jobs:dedup -- [--apply] [--db path]');

  const store = createJobStore(dbPath);
  try {
    const { rekeys, groups } = store.planIdentityDedup();
    for (const { key, representative, duplicates } of groups) {
      console.log(`\n${key}  (${duplicates.length + 1})`);
      console.log(`  keep  ${describe(representative)}`);
      for (const duplicate of duplicates) console.log(`  dup   ${describe(duplicate)}`);
    }
    const duplicates = groups.reduce((sum, group) => sum + group.duplicates.length, 0);
    console.log(`\nמפתחות זהות לעדכון: ${rekeys.length}; קבוצות כפולות: ${groups.length}; שורות שיסומנו ככפולות: ${duplicates}.`);
    if (!apply) {
      console.log('הרצה יבשה — שום דבר לא נכתב. להחלה: npm run jobs:dedup -- --apply');
      return;
    }
    const result = store.applyIdentityDedup();
    console.log(`הוחל: ${result.rekeyed} מפתחות עודכנו, ${result.duplicates} שורות סומנו ככפולות ב-${result.groups} קבוצות.`);
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { runDedup(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
