#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';

function parseReference(argv) {
  if (!argv.length || argv[0] === '--latest') return { kind: 'latest' };
  const match = argv.join(' ').match(/^(?:--)?(run|action|collector)\s*#?([1-9]\d{0,8})$/i);
  if (!match) throw new Error('Use: npm run diagnostics -- --latest | run 12 | action 8 | collector 3');
  return { kind: match[1].toLowerCase(), id: Number(match[2]) };
}

export async function diagnosticRecord(store, reference) {
  if (reference.kind === 'latest') {
    const latest = (await store.diagnosticHistory())[0];
    if (!latest) return null;
    if (latest.kind === 'runs') return await store.getRun(latest.id);
    if (latest.kind === 'actions') return await store.getAction(latest.id);
    return await store.getCollectorRun(latest.id);
  }
  if (reference.kind === 'run') return await store.getRun(reference.id);
  if (reference.kind === 'action') return await store.getAction(reference.id);
  return await store.getCollectorRun(reference.id);
}

export async function printDiagnostic(argv = process.argv.slice(2)) {
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  try {
    const reference = parseReference(argv);
    const record = await diagnosticRecord(store, reference);
    if (!record) throw new Error('Diagnostic record not found.');
    console.log(JSON.stringify(record, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await printDiagnostic(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
