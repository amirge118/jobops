import { resolveCurrentUser } from '../../jobs/current-user.mjs';
import { exportPersonalData } from '../../jobs/candidate/data-export.mjs';
import { onboardingState } from '../../jobs/candidate/onboarding.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { sendJson } from '../http.mjs';

// Where a person stands, and the way to take their data with them.
export function createAccountRoutes({ config }) {
  const withStore = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try {
      return await callback(store, resolveCurrentUser().id);
    } finally {
      store.close();
    }
  };

  return async (request, response, url) => {
    if (request.method !== 'GET') return false;
    if (url.pathname === '/') {
      const { steps } = await withStore((store, userId) => onboardingState({ store, config, userId }));
      const needsStart = !config.demo && !steps.find(({ key }) => key === 'resume').done;
      response.writeHead(302, { Location: needsStart ? '/start' : '/scan', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    if (url.pathname === '/api/onboarding') {
      sendJson(response, 200, await withStore((store, userId) => onboardingState({ store, config, userId })));
      return true;
    }
    if (url.pathname === '/api/profile/export') {
      const data = await withStore((store, userId) => exportPersonalData({ store, userId }));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="jobops-my-data.json"',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(data, null, 2));
      return true;
    }
    return false;
  };
}
