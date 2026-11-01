// Composition root: opens the database and assembles one flat store from the
// per-domain repositories. Callers keep using store.someMethod(...).

import fs from 'node:fs';
import path from 'node:path';

import { openSqliteDatabase } from './database.mjs';
import { runMigrations } from './migrations/index.mjs';
import { createJobIdentity } from './job-identity.mjs';
import { createCompaniesRepository } from './repositories/companies.mjs';
import { createNotificationsRepository } from './repositories/notifications.mjs';
import { createJobsRepository } from './repositories/jobs.mjs';
import { createEvaluationsRepository } from './repositories/evaluations.mjs';
import { createDashboardRepository } from './repositories/dashboard.mjs';
import { createResumeGapsRepository } from './repositories/resume-gaps.mjs';
import { createLlmRepository } from './repositories/llm.mjs';
import { createSourcesRepository } from './repositories/sources.mjs';
import { createPagesRepository } from './repositories/pages.mjs';
import { createWhatsappMessagesRepository } from './repositories/whatsapp-messages.mjs';
import { createWhatsappHistoryRepository } from './repositories/whatsapp-history.mjs';
import { createCheckpointsRepository } from './repositories/checkpoints.mjs';
import { createRunsRepository } from './repositories/runs.mjs';
import { createDiagnosticsRepository } from './repositories/diagnostics.mjs';
import { createHealthRepository } from './repositories/health.mjs';
import { createLinkedinRepository } from './repositories/linkedin.mjs';
import { createWeeklyReportsRepository } from './repositories/weekly-reports.mjs';
import { createPulseRepository } from './repositories/pulse.mjs';
import { createProfileDocumentsRepository } from './repositories/profile-documents.mjs';
import { createRescoreRepository } from './repositories/rescore.mjs';
import { createApplicationsRepository } from './repositories/applications.mjs';
import { createUsersRepository } from './repositories/users.mjs';
import { createWeeklyStatsRepository } from './repositories/weekly-stats.mjs';

export { israelDay, sourceKindOf, sourceMixOf, GAP_TERM_STATUSES, JOB_DECISIONS } from './shared.mjs';

const REPOSITORIES = [
  createCompaniesRepository,
  createNotificationsRepository,
  createJobsRepository,
  createEvaluationsRepository,
  createDashboardRepository,
  createResumeGapsRepository,
  createLlmRepository,
  createSourcesRepository,
  createPagesRepository,
  createWhatsappMessagesRepository,
  createWhatsappHistoryRepository,
  createCheckpointsRepository,
  createRunsRepository,
  createDiagnosticsRepository,
  createHealthRepository,
  createLinkedinRepository,
  createWeeklyReportsRepository,
  createPulseRepository,
  createUsersRepository,
  createApplicationsRepository,
  createRescoreRepository,
  createProfileDocumentsRepository,
  createWeeklyStatsRepository,
];

// readonly opens an existing database without writing anything, schema
// included: /pulse and the other read-only tools must never change the data.
export function createJobStore(databasePath, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = openSqliteDatabase(databasePath, { readonly });
  if (!readonly) runMigrations(db.raw);

  const store = {};
  const context = { db, store, identity: createJobIdentity(db) };
  for (const createRepository of REPOSITORIES) {
    for (const [name, method] of Object.entries(createRepository(context))) {
      if (name in store) throw new Error(`Duplicate store method: ${name}`);
      store[name] = method;
    }
  }
  store.close = () => db.close();
  return store;
}
