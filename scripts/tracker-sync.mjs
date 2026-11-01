#!/usr/bin/env node

// For skills and tools that edit data/applications.md. The rows in the app are
// the source of truth, so a changed file counts only once it is adopted.
//
//   npm run tracker:status
//   npm run tracker:adopt

import { resolveCurrentUser } from './jobs/current-user.mjs';
import { loadJobsConfig } from './jobs/config.mjs';
import { createJobStore } from './jobs/store.mjs';
import { createTrackerService } from './jobs/tracker/tracker-service.mjs';

const config = loadJobsConfig();
const store = createJobStore(config.jobsDbPath);
const service = createTrackerService({ store, config, userId: resolveCurrentUser().id });
try {
  const { fileDrift, rows } = await service.list();
  if (process.argv.includes('--adopt')) console.log(`Adopted ${(await service.adoptFile()).rows} rows.`);
  else console.log(fileDrift ? 'data/applications.md differs from the app; run npm run tracker:adopt to take it in.' : `In sync: ${rows.length} rows.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
