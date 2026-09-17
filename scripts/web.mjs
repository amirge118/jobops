#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadJobsConfig } from './jobs/config.mjs';
import { syncConfiguredCompanyEntries } from './jobs/company-catalog.mjs';
import { createDemoEnvironment, runDemoAction } from './jobs/demo.mjs';
import { createJobStore } from './jobs/store.mjs';
import {
  CompanyRegistryError,
  normalizeCompanySource,
  resolveCompanyCandidate,
} from './jobs/company-registry.mjs';
import { createCompanyResearcher } from './jobs/company-research.mjs';
import { createCompanySourceResolver, probeCompanySource } from './jobs/company-source-resolver.mjs';
import { fetchPageWithBrowser } from './jobs/browser-fetch.mjs';
import { createDashboardQueries } from './dashboard/queries.mjs';
import { serveDashboardAsset } from './dashboard/static.mjs';
import { createActionController, runCommand } from './dashboard/actions.mjs';
import { blockersForAction, createReadinessService } from './dashboard/readiness.mjs';
import { buildScanDiagnosis } from './dashboard/scan-diagnosis.mjs';
import { parseDashboardOptions } from './jobs/dashboard.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from './liveness-browser.mjs';

export { runCommand, sanitizeCommandOutput } from './dashboard/actions.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024;

function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 4177;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return { port, open: argv.includes('--open'), demo: argv.includes('--demo') };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function requireObjectBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CompanyRegistryError('invalid_request', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    throw new CompanyRegistryError('invalid_request', 'Request body contains unsupported fields');
  }
  return body;
}

function requireJsonContentType(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
  }
}

function primaryCompanySourceUrl(company) {
  const sources = Array.isArray(company?.sources) ? company.sources : [];
  const source = sources.find((item) => item.enabled && item.provider !== 'unsupported') ||
    sources.find((item) => item.provider !== 'unsupported') || sources[0] || null;
  return source?.careersUrl || null;
}

function companyErrorStatus(error) {
  if (!(error instanceof CompanyRegistryError)) return null;
  if (['company_not_found', 'job_not_found'].includes(error.code)) return 404;
  if (['source_conflict', 'job_not_suitable', 'company_not_resolved', 'company_not_scannable', 'approval_required', 'company_research_busy'].includes(error.code)) return 409;
  if (['company_research_timeout', 'company_research_login_required', 'company_research_failed'].includes(error.code)) return 503;
  return 400;
}

function sendCompanyError(response, error) {
  const statusCode = companyErrorStatus(error);
  if (!statusCode) return false;
  sendJson(response, statusCode, { error: error.message, code: error.code });
  return true;
}

export function createDashboardServer({
  config = loadJobsConfig(), execute = runCommand, readiness = null, researchCompany = null,
  probeSource = probeCompanySource, browserResolve = null,
} = {}) {
  const staticDir = path.join(config.rootDir, 'web');
  const bootstrapStore = createJobStore(config.jobsDbPath);
  try {
    if (!config.demo) syncConfiguredCompanyEntries(bootstrapStore, config.rootDir);
    bootstrapStore.pruneDiagnostics();
  } finally {
    bootstrapStore.close();
  }
  const { action, startAction } = createActionController(config, execute);
  const queries = createDashboardQueries(config, action);
  const readinessService = readiness || createReadinessService(config, () => {
    const store = createJobStore(config.jobsDbPath);
    try { return store.getCollectorStatusSummary(); }
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

  function snapshot() {
    return queries.snapshot();
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, snapshot());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/summary') {
        sendJson(response, 200, queries.summary());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/scan') {
        const scan = queries.scan();
        const readinessState = await readinessService.inspect({ force: url.searchParams.get('refresh') === '1' });
        sendJson(response, 200, {
          ...scan,
          readiness: readinessState,
          diagnosis: buildScanDiagnosis({ lastRun: scan.lastRun, readiness: readinessState }),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/readiness') {
        sendJson(response, 200, {
          readiness: await readinessService.inspect({ force: url.searchParams.get('refresh') === '1' }),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/jobs') {
        sendJson(response, 200, queries.jobs());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/diagnostics/history') {
        sendJson(response, 200, queries.diagnosticHistory());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/companies') {
        sendJson(response, 200, queries.companies());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/whatsapp/history') {
        // This endpoint queues remote work. Requiring a non-simple JSON
        // request prevents an unrelated website from triggering it through a
        // cross-origin form or text/plain POST to localhost.
        requireJsonContentType(request);
        const body = requireObjectBody(await readJson(request), ['days']);
        const days = body.days == null ? 30 : Number(body.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw Object.assign(new Error('days must be an integer between 1 and 365'), { statusCode: 400 });
        }
        const groupsTotal = config.sources.whatsapp?.groups?.length || 0;
        if (!groupsTotal) throw Object.assign(new Error('No WhatsApp groups are configured'), { statusCode: 409 });
        const toTs = Date.now();
        const store = createJobStore(config.jobsDbPath);
        try {
          const fromTs = toTs - days * 24 * 60 * 60 * 1_000;
          const groups = (config.sources.whatsapp?.groups || []).map((group) => {
            const lastCollectedAt = store.getWhatsAppGroupCollectionStats(group.jid).lastCollectedAt;
            return {
              name: group.name,
              // Keep one second of overlap so the latest collected message can
              // be used as WhatsApp's exclusive history cursor. Deduplication
              // makes replaying that boundary message harmless.
              requestedFrom: Math.max(fromTs, Math.min((lastCollectedAt ?? fromTs) - 1_000, toTs - 1)),
            };
          });
          const result = store.requestWhatsAppHistory({
            fromTs,
            toTs,
            groupsTotal,
            groups,
          });
          sendJson(response, result.created ? 202 : 200, result);
        } finally { store.close(); }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/companies/resolve') {
        const body = requireObjectBody(await readJson(request), ['jobKey', 'name', 'url']);
        const store = createJobStore(config.jobsDbPath);
        try {
          let candidate;
          if (body.jobKey != null) {
            if (Object.keys(body).length !== 1 || !/^[a-f0-9]{24}$/.test(String(body.jobKey))) {
              throw new CompanyRegistryError('invalid_job_key', 'A valid job key is required');
            }
            candidate = store.resolveCompanyCandidateForJob(String(body.jobKey));
          } else {
            if (body.name == null || body.url == null) {
              throw new CompanyRegistryError('invalid_request', 'Company name and job or careers URL are required');
            }
            candidate = resolveCompanyCandidate({
              company: body.name,
              jobUrl: body.url,
              discoverySource: 'manual',
            });
          }
          const saved = store.upsertCompanyCandidate(candidate);
          // Explicitly flagging a job's company from the Decisions page means
          // "consider tracking this" — guarantee it lands in 'candidate',
          // even if it was previously ignored or paused (not just on first
          // discovery, which upsertCompanyCandidate alone would cover).
          const company = store.markCompanyAsCandidate(saved.company.id);
          sendJson(response, 200, {
            candidate: company,
            sources: saved.sources,
            resolvedSource: candidate.source,
          });
        } finally { store.close(); }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/companies/research') {
        const body = requireObjectBody(await readJson(request), ['name']);
        if (body.name == null) throw new CompanyRegistryError('invalid_request', 'Company name is required');
        const result = await companyResearch(body.name);
        const store = createJobStore(config.jobsDbPath);
        try {
          const saved = store.upsertCompanyCandidate(result.candidate);
          const resolvedSource = saved.sources.find((source) =>
            source.provider === result.candidate.source?.provider &&
            source.careersUrl === result.candidate.source?.careersUrl,
          );
          if (resolvedSource && result.probe) {
            store.recordCompanySourceProbe(
              resolvedSource.id,
              result.probe,
              result.research?.evidenceUrls || [],
            );
          }
          const company = store.getCompany(saved.company.id);
          sendJson(response, 200, {
            candidate: company,
            sources: company.sources,
            resolvedSource: result.candidate.source,
            research: result.research,
            probe: result.probe,
          });
        } finally { store.close(); }
        return;
      }

      const companyManualSourceMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/manual-source$/)
        : null;
      if (companyManualSourceMatch) {
        const body = requireObjectBody(
          await readJson(request),
          ['careersUrl', 'jobPathPrefix', 'jobPathSegments', 'ignoredJobPaths', 'allowEmpty'],
        );
        if (body.careersUrl == null || body.jobPathPrefix == null || body.jobPathSegments == null) {
          throw new CompanyRegistryError('invalid_request', 'careersUrl, jobPathPrefix and jobPathSegments are required');
        }
        const store = createJobStore(config.jobsDbPath);
        try {
          const companyId = Number(companyManualSourceMatch[1]);
          const company = store.getCompany(companyId);
          if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
          // This is the manual escape hatch for exactly the case the automated
          // research pipeline cannot close on its own: a real, working career
          // page whose ATS auto-detection came back unsupported/needs_adapter.
          // official-html is the one provider that a human can always finish
          // configuring by hand once they know the job link's URL shape.
          const source = normalizeCompanySource({
            provider: 'official-html',
            careersUrl: body.careersUrl,
            config: {
              jobPathPrefix: body.jobPathPrefix,
              jobPathSegments: body.jobPathSegments,
              ignoredJobPaths: body.ignoredJobPaths,
              allowEmpty: body.allowEmpty,
            },
          });
          const probe = await probeSource(source, company.name);
          const verified = ['verified_jobs', 'verified_empty'].includes(probe.status);
          const saved = store.upsertCompanySource(companyId, { ...source, enabled: verified });
          store.recordCompanySourceProbe(saved.id, probe, []);
          sendJson(response, 200, { company: store.getCompany(companyId), probe });
        } finally { store.close(); }
        return;
      }

      const companyBrowserProbeGetMatch = request.method === 'GET'
        ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/browser-probe$/)
        : null;
      if (companyBrowserProbeGetMatch) {
        const companyId = Number(companyBrowserProbeGetMatch[1]);
        if (browserProbe.companyId !== companyId) {
          sendJson(response, 200, { status: 'idle' });
        } else if (browserProbe.running) {
          sendJson(response, 200, { status: 'running', startedAt: browserProbe.startedAt });
        } else if (browserProbe.error) {
          sendJson(response, 200, { status: 'error', error: browserProbe.error });
        } else {
          sendJson(response, 200, { status: 'done', probe: browserProbe.probe });
        }
        return;
      }

      const companyBrowserProbePostMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/browser-probe$/)
        : null;
      if (companyBrowserProbePostMatch) {
        if (browserProbe.running) {
          throw Object.assign(new Error('כבר מתבצעת בדיקת דפדפן על חברה אחרת. יש להמתין לסיומה.'), { statusCode: 409 });
        }
        const body = requireObjectBody(await readJson(request), ['url']);
        const companyId = Number(companyBrowserProbePostMatch[1]);
        const lookupStore = createJobStore(config.jobsDbPath);
        let company;
        try { company = lookupStore.getCompany(companyId); } finally { lookupStore.close(); }
        if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
        const candidateUrl = body.url || primaryCompanySourceUrl(company);
        if (!candidateUrl) {
          throw new CompanyRegistryError('invalid_request', 'A careers URL is required to try a browser probe');
        }

        Object.assign(browserProbe, {
          running: true, companyId, startedAt: Date.now(), probe: null, error: null,
        });
        // Fire-and-forget: this endpoint returns immediately (202) and the
        // dashboard polls GET .../browser-probe for the outcome, exactly
        // because a real browser render can take many seconds — see
        // scripts/jobs/browser-fetch.mjs.
        resolveWithBrowser({ companyName: company.name, candidateUrls: [candidateUrl], evidenceUrls: [] })
          .then((result) => {
            const persistStore = createJobStore(config.jobsDbPath);
            try {
              const saved = persistStore.upsertCompanyCandidate(result.candidate);
              const resolvedSource = saved.sources.find((source) =>
                source.provider === result.candidate.source?.provider &&
                source.careersUrl === result.candidate.source?.careersUrl);
              if (resolvedSource && result.probe) persistStore.recordCompanySourceProbe(resolvedSource.id, result.probe, []);
            } finally { persistStore.close(); }
            browserProbe.probe = result.probe;
          })
          .catch((error) => {
            browserProbe.error = String(error?.message || error || 'הבדיקה בדפדפן נכשלה').slice(0, 300);
          })
          .finally(() => { browserProbe.running = false; });

        sendJson(response, 202, { status: 'running' });
        return;
      }

      const companyWatchMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/watch$/)
        : null;
      if (companyWatchMatch) {
        const body = requireObjectBody(await readJson(request), []);
        void body;
        const store = createJobStore(config.jobsDbPath);
        try {
          const companyId = Number(companyWatchMatch[1]);
          store.approveCompany(companyId);
          sendJson(response, 200, { company: store.getCompany(companyId) });
        } finally { store.close(); }
        return;
      }

      const companyStatusMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/status$/)
        : null;
      if (companyStatusMatch) {
        const body = requireObjectBody(await readJson(request), ['status']);
        if (!['paused', 'ignored'].includes(body.status)) {
          throw new CompanyRegistryError('invalid_status', 'Status must be paused or ignored');
        }
        const store = createJobStore(config.jobsDbPath);
        try {
          const companyId = Number(companyStatusMatch[1]);
          store.setCompanyStatus(companyId, body.status);
          sendJson(response, 200, { company: store.getCompany(companyId) });
        } finally { store.close(); }
        return;
      }

      const diagnosticMatch = request.method === 'GET'
        ? url.pathname.match(/^\/api\/diagnostics\/(runs|actions|collectors)\/([1-9]\d{0,8})$/) : null;
      if (diagnosticMatch) {
        const result = queries.diagnosticDetail(diagnosticMatch[1], Number(diagnosticMatch[2]));
        sendJson(response, result.statusCode, result.payload);
        return;
      }

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
            return;
          }
        }
        sendJson(response, 202, { action: startAction(actionName, body) });
        return;
      }

      const archiveMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})\/archive$/)
        : null;
      if (archiveMatch) {
        const store = createJobStore(config.jobsDbPath);
        try {
          if (!store.archiveJob(archiveMatch[1])) {
            sendJson(response, 404, { error: 'המשרה לא נמצאה או שכבר הועברה לארכיון' });
            return;
          }
        } finally {
          store.close();
        }
        sendJson(response, 200, { archived: true, state: snapshot() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/jobs/archive-failed') {
        const store = createJobStore(config.jobsDbPath);
        let result;
        try {
          result = store.archiveJobsByErrorCode([...NON_RETRYABLE_FAILURE_CODES]);
        } finally {
          store.close();
        }
        sendJson(response, 200, { ...result, state: snapshot() });
        return;
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
}

export async function startDashboard(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const demo = options.demo ? createDemoEnvironment({ rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) : null;
  if (demo) demo.store.close();
  const config = demo?.config || loadJobsConfig();
  const server = createDashboardServer({ config, execute: demo ? runDemoAction : runCommand });
  if (demo) server.once('close', demo.cleanup);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, HOST, resolve);
  });
  const url = `http://${HOST}:${options.port}`;
  console.log(`jobOps dashboard: ${url}`);

  if (options.open) {
    const child = spawn('/usr/bin/open', ['-a', config.browser?.application || 'Google Chrome', url], {
      stdio: 'ignore',
    });
    child.once('error', (error) => console.error(`לא ניתן לפתוח את הדשבורד: ${error.message}`));
  }
  return { server, url };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startDashboard().catch((error) => {
    console.error(`הדשבורד לא עלה: ${error.message}`);
    process.exitCode = 1;
  });
}
