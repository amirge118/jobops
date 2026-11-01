import { resolveCurrentUser } from '../../jobs/current-user.mjs';
import { createFilterSuggester } from '../../jobs/candidate/filter-suggestion.mjs';
import { estimateRescore, requestRescore } from '../../jobs/candidate/rescore.mjs';
import { resolveLocationFilter, resolveTitleFilter } from '../../jobs/candidate/search-filters.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { applyUserSettings, saveUserSettings } from '../../jobs/user-settings.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';
import { blockersForAction } from '../readiness.mjs';

const MAX_SETTINGS_BODY_BYTES = 256 * 1024;

function effectiveSearch(config) {
  const title = resolveTitleFilter(config);
  const location = resolveLocationFilter(config) ?? { always_allow: [], allow: [], block: [] };
  return {
    filters: { domains: [], acceptedLocations: [], preferredSectors: [], ...config.filters },
    decision: { minimumScore: config.decision?.minimumScore ?? null, exactMatchScore: config.decision?.exactMatchScore ?? null },
    search: {
      rolePreset: 'generic', focusRole: '', excludedRoleTypes: [], maxLevel: '', levelCapTitles: [], avoidPeopleManagement: false, homeCountry: '',
      ...config.search,
      titleFilter: { positive: title.positive, negative: title.negative, alwaysAllow: title.always_allow },
      locationFilter: { alwaysAllow: location.always_allow, allow: location.allow, block: location.block },
    },
  };
}

// What this person looks for, and acting on a change to it. Nothing here re-scores
// a job unless the request says so.
export function createSearchSettingsRoutes({ config, readinessService, startAction, suggestFilters = createFilterSuggester(config) }) {
  const withStore = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try {
      return await callback(store, resolveCurrentUser().id);
    } finally {
      store.close();
    }
  };

  async function startRescoreRun() {
    try {
      const readiness = await readinessService.inspect({ force: true });
      if (blockersForAction(readiness, 'retry-failed', {}).length) return false;
      await startAction('retry-failed', {});
      return true;
    } catch (error) {
      if (error.statusCode === 409) return false;
      throw error;
    }
  }

  return async (request, response, url) => {
    const { pathname } = url;
    if (pathname === '/api/profile/search' && request.method === 'GET') {
      sendJson(response, 200, await withStore(async (store, userId) => effectiveSearch(await applyUserSettings(config, store, userId))));
      return true;
    }
    if (pathname === '/api/profile/search' && request.method === 'POST') {
      const body = requireObjectBody(await readJson(request, { maxBytes: MAX_SETTINGS_BODY_BYTES }), ['settings']);
      if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) throw Object.assign(new Error('settings must be an object'), { statusCode: 400 });
      sendJson(response, 200, await withStore(async (store, userId) => {
        await saveUserSettings(store, userId, body.settings, config);
        return effectiveSearch(await applyUserSettings(config, store, userId));
      }));
      return true;
    }
    if (pathname === '/api/profile/search/suggest-filters' && request.method === 'POST') {
      requireObjectBody(await readJson(request), []);
      const input = await withStore(async (store, userId) => ({
        preferences: (await store.getCurrentDocument(userId, 'preferences'))?.content ?? '',
        focusRole: (await applyUserSettings(config, store, userId)).search?.focusRole ?? '',
      }));
      sendJson(response, 200, { suggestion: await suggestFilters(input) });
      return true;
    }
    if (pathname === '/api/profile/rescore' && request.method === 'GET') {
      sendJson(response, 200, await withStore(async (store, userId) => {
        try {
          return await estimateRescore({ store, config, userId });
        } catch {
          return { active: 0, rejected: 0, rejectedCapped: false, requested: 0, estimatedTokens: null, rejectedWindowDays: 0 };
        }
      }));
      return true;
    }
    if (pathname === '/api/profile/rescore' && request.method === 'POST') {
      const body = requireObjectBody(await readJson(request), ['includeRejected']);
      if (body.includeRejected !== undefined && typeof body.includeRejected !== 'boolean') throw Object.assign(new Error('includeRejected must be true or false'), { statusCode: 400 });
      const marked = await withStore((store, userId) => requestRescore({ store, config, userId, includeRejected: body.includeRejected === true }));
      sendJson(response, 200, { marked, started: marked > 0 ? await startRescoreRun() : false });
      return true;
    }
    return false;
  };
}
