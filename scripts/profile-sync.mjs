#!/usr/bin/env node

// For skills and hand edits of profile/*.md. The dashboard's documents are the
// source of truth, so a changed file counts only once it is adopted.
//
//   npm run profile:status                  # which files differ from the documents
//   npm run profile:adopt -- resume         # take that file into its document

import { resolveCurrentUser } from './jobs/current-user.mjs';
import { loadJobsConfig } from './jobs/config.mjs';
import { DOCUMENT_KINDS, driftedKinds, importMissingFromFiles } from './jobs/candidate/file-sync.mjs';
import { createProfileService } from './jobs/candidate/profile-service.mjs';
import { createJobStore } from './jobs/store.mjs';

const args = process.argv.slice(2);
const config = loadJobsConfig();
const store = createJobStore(config.jobsDbPath);
const userId = resolveCurrentUser().id;
try {
  await importMissingFromFiles({ store, config, userId });
  if (args[0] === '--adopt') {
    const kinds = args.slice(1);
    const unknown = kinds.filter((kind) => !DOCUMENT_KINDS.includes(kind));
    if (!kinds.length || unknown.length) throw new Error(`Name what to adopt: ${DOCUMENT_KINDS.join(', ')}`);
    const service = createProfileService({ store, config, userId });
    for (const kind of kinds) console.log(`${kind}: ${(await service.adoptFile(kind)).status}`);
  } else {
    const drifted = await driftedKinds({ store, config, userId });
    console.log(drifted.length ? `Files differ from their documents: ${drifted.join(', ')}` : 'All files match their documents.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
