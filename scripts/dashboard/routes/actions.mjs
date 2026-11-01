import { parseDashboardOptions } from '../../jobs/dashboard.mjs';
import { blockersForAction } from '../readiness.mjs';
import { readJson, sendJson } from '../http.mjs';

// Long-running actions started from the dashboard.
export function createActionsRoutes({ config, readinessService, startAction }) {
  return async (request, response, url) => {
    const actionMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/actions\/(scan|verify-groups|open-jobs|retry-failed|mark-read|process-backlog)$/)
      : null;
    if (actionMatch) {
      const body = await readJson(request);
      const actionName = actionMatch[1];
      const options = actionName === 'scan'
        ? parseDashboardOptions(body, config.scan.maxLookbackDays)
        : {};
      if (['scan', 'retry-failed', 'process-backlog'].includes(actionName)) {
        const readinessState = await readinessService.inspect({ force: true });
        const blockers = blockersForAction(readinessState, actionName, options);
        if (blockers.length) {
          sendJson(response, 409, {
            code: 'scan_not_ready',
            error: 'הסריקה לא הופעלה כי המערכת אינה מוכנה.',
            blockers,
            readiness: readinessState,
          });
          return true;
        }
      }
      sendJson(response, 202, { action: await startAction(actionName, body) });
      return true;
    }

    return false;
  };
}
