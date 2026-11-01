import { buildScanDiagnosis } from '../scan-diagnosis.mjs';
import { runHealthCheck } from '../../jobs/health-check.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { sendJson } from '../http.mjs';

// What the pages read: state, stats, diagnostics, and the health check.
export function createOverviewRoutes({ config, queries, readinessService, snapshot }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, await snapshot());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/summary') {
      sendJson(response, 200, await queries.summary());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/scan') {
      const scan = await queries.scan();
      const readinessState = await readinessService.inspect({ force: url.searchParams.get('refresh') === '1' });
      sendJson(response, 200, {
        ...scan,
        readiness: readinessState,
        diagnosis: buildScanDiagnosis({ lastRun: scan.lastRun, readiness: readinessState }),
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/readiness') {
      sendJson(response, 200, {
        readiness: await readinessService.inspect({ force: url.searchParams.get('refresh') === '1' }),
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      sendJson(response, 200, await queries.jobs());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/llm-usage/daily') {
      const days = Number(url.searchParams.get('days') || 14);
      sendJson(response, 200, await queries.dailyLlmUsage(days));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/decision-stats') {
      sendJson(response, 200, await queries.decisionStats());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/diagnostics/history') {
      sendJson(response, 200, await queries.diagnosticHistory());
      return true;
    }

    const diagnosticMatch = request.method === 'GET'
      ? url.pathname.match(/^\/api\/diagnostics\/(runs|actions|collectors)\/([1-9]\d{0,8})$/) : null;
    if (diagnosticMatch) {
      const result = await queries.diagnosticDetail(diagnosticMatch[1], Number(diagnosticMatch[2]));
      sendJson(response, result.statusCode, result.payload);
      return true;
    }

    // The scheduled health check's findings; POST re-checks now without a
    // WhatsApp alert (the person is already looking at the page).
    if (url.pathname === '/api/health' && ['GET', 'POST'].includes(request.method)) {
      const store = createJobStore(config.jobsDbPath);
      try {
        if (request.method === 'POST') await runHealthCheck({ store, config, notify: false });
        sendJson(response, 200, { checkedAt: await store.getHealthCheckedAt(), findings: await store.listHealthFindings() });
      } finally { store.close(); }
      return true;
    }

    return false;
  };
}
