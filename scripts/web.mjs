#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadJobsConfig } from './jobs/config.mjs';
import { loadEffectiveConfig } from './jobs/effective-config.mjs';
import { syncConfiguredCompanyEntries } from './jobs/company-catalog.mjs';
import { createDemoEnvironment, runDemoAction } from './jobs/demo.mjs';
import { createJobStore } from './jobs/store.mjs';
import { createCompanyResearcher } from './jobs/company-research.mjs';
import { createCompanySourceResolver, probeCompanySource } from './jobs/company-source-resolver.mjs';
import { fetchPageWithBrowser } from './jobs/browser-fetch.mjs';
import { createDashboardQueries } from './dashboard/queries.mjs';
import { serveDashboardAsset } from './dashboard/static.mjs';
import { createActionController, runCommand } from './dashboard/actions.mjs';
import { sendCompanyError, sendJson } from './dashboard/http.mjs';
import { guardRequest } from './dashboard/request-guard.mjs';
import { createActionsRoutes } from './dashboard/routes/actions.mjs';
import { createCompaniesRoutes } from './dashboard/routes/companies.mjs';
import { createJobsRoutes } from './dashboard/routes/jobs.mjs';
import { createOverviewRoutes } from './dashboard/routes/overview.mjs';
import { createPersonalAreaRoutes } from './dashboard/routes/personal-area.mjs';
import { createProfileRoutes } from './dashboard/routes/profile.mjs';
import { createSearchSettingsRoutes } from './dashboard/routes/search-settings.mjs';
import { createSourceSettingsRoutes } from './dashboard/routes/source-settings.mjs';
import { createSourcesRoutes } from './dashboard/routes/sources.mjs';
import { createTrackerRoutes } from './dashboard/routes/tracker.mjs';
import { CONFIG_RESTART_EXIT_CODE, watchConfigForRestart } from './dashboard/config-watch.mjs';
import { DASHBOARD_LABEL } from './dashboard/service.mjs';
import { applySourceChange } from './dashboard/source-change.mjs';
import { createReadinessService } from './dashboard/readiness.mjs';
import { setCodexUsageRecorder } from './jobs/llm-usage.mjs';

export { runCommand, sanitizeCommandOutput } from './dashboard/actions.mjs';

const HOST = '127.0.0.1';

function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 4177;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return { port, open: argv.includes('--open'), demo: argv.includes('--demo') };
}

export async function createDashboardServer({
  config = loadJobsConfig(), execute = runCommand, readiness = null, researchCompany = null,
  probeSource = probeCompanySource, browserResolve = null, onSourcesChanged = () => {},
} = {}) {
  const staticDir = path.join(config.rootDir, 'web');
  const bootstrapStore = createJobStore(config.jobsDbPath);
  try {
    if (!config.demo) await syncConfiguredCompanyEntries(bootstrapStore, config.rootDir);
    await bootstrapStore.pruneDiagnostics();
  } finally {
    bootstrapStore.close();
  }
  const { action, startAction } = createActionController(config, execute);
  // Company research runs Codex inside this process; its usage is recorded
  // like scan usage (scans are separate processes with their own recorder).
  if (!config.demo) {
    setCodexUsageRecorder(async (entry) => {
      const store = createJobStore(config.jobsDbPath);
      try { await store.recordCodexCall(entry); }
      finally { store.close(); }
    });
  }
  const queries = createDashboardQueries(config, action);
  const readinessService = readiness || createReadinessService(config, async () => {
    const store = createJobStore(config.jobsDbPath);
    try { return await store.getCollectorStatusSummary(); }
    finally { store.close(); }
  });
  const companyResearch = researchCompany || createCompanyResearcher(config);
  const resolveWithBrowser = browserResolve || createCompanySourceResolver({ fetchPage: fetchPageWithBrowser });
  // A real headless-browser render is far heavier than every other discovery
  // step (seconds, a whole Chromium process) and is only ever triggered
  // explicitly by a person for one company at a time, so one shared,
  // process-wide slot — the same shape as the single CLI `action` above —
  // is enough; it also stops someone launching several Chromium instances
  // at once from repeated clicks.
  const browserProbe = { running: false, companyId: null, startedAt: null, probe: null, error: null };

  async function snapshot() {
    return await queries.snapshot();
  }

  const routes = [
    createOverviewRoutes({ config, queries, readinessService, snapshot }),
    createPersonalAreaRoutes({ config }),
    createProfileRoutes({ config }),
    createSearchSettingsRoutes({ config, readinessService, startAction }),
    createSourceSettingsRoutes({ config, onSourcesChanged }),
    createSourcesRoutes({ config, queries }),
    createCompaniesRoutes({ config, queries, companyResearch, probeSource, resolveWithBrowser, browserProbe }),
    createActionsRoutes({ config, readinessService, startAction }),
    createJobsRoutes({ config, snapshot }),
    createTrackerRoutes({ config }),
  ];

  const server = http.createServer(async (request, response) => {
    try {
      guardRequest(request);
      const url = new URL(request.url, `http://${HOST}`);
      for (const route of routes) {
        if (await route(request, response, url)) return;
      }

      if (request.method !== 'GET') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }

      if (serveDashboardAsset(response, staticDir, url.pathname)) return;
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (sendCompanyError(response, error)) return;
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, { error: statusCode >= 500 ? 'Internal server error' : error.message });
    }
  });
  server.isBusy = () => action.status === 'running' || browserProbe.running;
  return server;
}

export async function startDashboard(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const demo = options.demo ? await createDemoEnvironment({ rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) : null;
  if (demo) demo.store.close();
  const config = demo?.config || await loadEffectiveConfig();
  const managed = !demo && process.env.XPC_SERVICE_NAME === DASHBOARD_LABEL;
  const server = await createDashboardServer({
    config, execute: demo ? runDemoAction : runCommand,
    onSourcesChanged: () => applySourceChange({ managed, isBusy: () => server.isBusy() }),
  });
  if (demo) server.once('close', demo.cleanup);
  if (!demo) {
    // Only the LaunchAgent copy restarts itself; a terminal run would just end.
    const stopWatching = watchConfigForRestart({
      configPath: config.configPath,
      isBusy: server.isBusy,
      validate: () => loadJobsConfig(config.configPath),
      onRestart: managed
        ? () => {
          console.log('config/jobs.yml השתנה; הדשבורד עולה מחדש עם ההגדרות החדשות.');
          process.exit(CONFIG_RESTART_EXIT_CODE);
        }
        : () => console.log('config/jobs.yml השתנה; הפעל מחדש את הדשבורד כדי לטעון את ההגדרות החדשות.'),
    });
    server.once('close', stopWatching);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, HOST, resolve);
  });
  const url = `http://${HOST}:${options.port}`;
  console.log(`jobOps dashboard: ${url}`);

  if (options.open) openDashboardInBrowser(url, config);
  return { server, url };
}

export function openDashboardInBrowser(url, config = loadJobsConfig()) {
  const child = spawn('/usr/bin/open', ['-a', config.browser?.application || 'Google Chrome', url], {
    stdio: 'ignore',
  });
  child.once('error', (error) => console.error(`לא ניתן לפתוח את הדשבורד: ${error.message}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startDashboard().catch((error) => {
    console.error(`הדשבורד לא עלה: ${error.message}`);
    process.exitCode = 1;
  });
}
