import { loadJobsConfig } from './config.mjs';
import { resolveCurrentUser } from './current-user.mjs';
import { createJobStore } from './store.mjs';
import { applyUserSettings } from './user-settings.mjs';

// The config a process should run with: config/jobs.yml plus what was saved in
// the app. Read once at start, like the file itself.
export async function loadEffectiveConfig(configPath) {
  const config = configPath ? loadJobsConfig(configPath) : loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  try {
    return await applyUserSettings(config, store, resolveCurrentUser().id);
  } finally {
    store.close();
  }
}
