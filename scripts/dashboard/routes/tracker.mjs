import { resolveCurrentUser } from '../../jobs/current-user.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { createTrackerService } from '../../jobs/tracker/tracker-service.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

const ROW_ROUTE = /^\/api\/tracker\/([1-9]\d{0,8})$/;

// A person's job applications, always the current user's own.
export function createTrackerRoutes({ config }) {
  const withService = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try {
      return await callback(createTrackerService({ store, config, userId: resolveCurrentUser().id }));
    } finally {
      store.close();
    }
  };

  return async (request, response, url) => {
    const { pathname } = url;
    if (pathname === '/api/tracker' && request.method === 'GET') {
      sendJson(response, 200, await withService((service) => service.list()));
      return true;
    }
    if (request.method !== 'POST') return false;
    if (pathname === '/api/tracker') {
      const body = requireObjectBody(await readJson(request), ['company', 'role', 'status', 'date', 'notes']);
      sendJson(response, 200, await withService((service) => service.add(body)));
      return true;
    }
    if (pathname === '/api/tracker/adopt-file') {
      requireObjectBody(await readJson(request), []);
      sendJson(response, 200, await withService((service) => service.adoptFile()));
      return true;
    }
    const row = pathname.match(ROW_ROUTE);
    if (row) {
      const body = requireObjectBody(await readJson(request), ['status', 'notes']);
      sendJson(response, 200, await withService((service) => service.update(Number(row[1]), body)));
      return true;
    }
    return false;
  };
}
