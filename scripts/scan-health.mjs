#!/usr/bin/env node
// Read-only digest of the latest scan for the /scan-health skill: the latest
// finished run of every source, the dashboard's failure list with the jobs
// behind it, and the source health the scan page shows. Writes nothing.
//
//   npm run jobs:health                     # JSON digest
//   npm run jobs:health -- --runs 3         # last 3 runs per source

import { loadJobsConfig } from './jobs/config.mjs';
import { createDashboardQueries } from './dashboard/queries.mjs';
import { createJobStore } from './jobs/store.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from './liveness-browser.mjs';

const SOURCES = ['ats', 'whatsapp', 'linkedin'];
const runsIndex = process.argv.indexOf('--runs');
const runsPerSource = Math.max(1, Number(runsIndex >= 0 ? process.argv[runsIndex + 1] : 1) || 1);

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

const config = loadJobsConfig();
const scan = await createDashboardQueries(config, { status: 'idle' }).scan();
const store = createJobStore(config.jobsDbPath, { readonly: true });

// Only the parts of details_json that point at a problem; healthy counters
// stay as numbers so the digest stays short.
function problemsOf(details) {
  const problems = [];
  const visit = (value, path) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}[${item?.name ?? item?.key ?? i}]`)); return; }
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (['error', 'failure', 'reason', 'haltedBy', 'warning', 'gap'].includes(key) && child != null && child !== '') {
        problems.push({ at: here, value: child });
      } else if (key === 'failureReasons' && Object.keys(child || {}).length) {
        problems.push({ at: here, value: child });
      } else if (['failed', 'failedMessages'].includes(key) && Number(child) > 0) {
        problems.push({ at: here, value: child });
      } else if (key === 'status' && ['failed', 'partial', 'incomplete', 'skipped'].includes(child)) {
        problems.push({ at: here, value: child });
      } else {
        visit(child, here);
      }
    }
  };
  visit(details, '');
  return problems;
}

const latestRuns = Object.fromEntries(await Promise.all(SOURCES.map(async (source) => [source, await Promise.all((await store.listFinishedRunsForSource(source, runsPerSource)).map(async (run) => {
  const details = parse(run.details_json);
  return {
    id: run.id, startedAt: iso(run.started_at), finishedAt: iso(run.finished_at),
    window: { from: iso(run.from_ts), to: iso(run.to_ts) },
    status: run.status, windowStatus: run.window_status ?? null, error: run.error,
    diagnostic: parse(run.diagnostic_json),
    processing: details?.processing?.totals ?? null,
    problems: problemsOf(details),
    failedEvents: (await store.listFailedRunEvents(run.id)).map((event) => ({ ...event, details: parse(event.details) })),
  };
}))])));

// The failure list on the scan page: active jobs whose last attempt failed.
const failedJobs = (await store.listFailedJobs()).map((job) => ({
  code: job.last_error_code,
  retryable: !NON_RETRYABLE_FAILURE_CODES.has(job.last_error_code),
  url: job.canonical_url,
  company: job.company, title: job.title,
  sources: (parse(job.sources_json) || []).map((source) => source.kind ?? source.source ?? source),
  reason: job.last_error_reason,
  lastAttemptAt: iso(job.last_attempted_at), firstSeenAt: iso(job.first_seen_at),
}));

const resumeGapFailures = await store.countResumeGapFailures();
store.close();

const linkedin = scan.linkedin && {
  enabled: scan.linkedin.enabled,
  searches: scan.linkedin.searches.map((search) => ({
    key: search.key, enabled: search.enabled, lastStatus: search.lastStatus, lastReason: search.lastReason,
    lastSuccessAt: iso(search.lastSuccessAt), lastAttemptAt: iso(search.lastAttemptAt),
    endedBy: search.lastSummary?.endedBy, warning: search.lastSummary?.warning,
    gaps: (search.gaps || []).map((gap) => ({ from: iso(gap.from), to: iso(gap.to) })),
  })),
};

const whatsapp = {
  collector: scan.collector,
  backlog: scan.whatsappHistory?.backlog && {
    total: scan.whatsappHistory.backlog.total, failed: scan.whatsappHistory.backlog.failed,
    groups: scan.whatsappHistory.backlog.groups.map((group) => ({
      name: group.name, waiting: group.total, failed: group.failed, coverage: group.coverage,
      syncState: group.syncState, gapFrom: iso(group.gapFrom),
      historyStatus: group.historyStatus, historyReason: group.historyReason,
    })),
  },
  lastHistoryRequest: scan.whatsappHistory?.request ?? null,
};

console.log(JSON.stringify({
  generatedAt: iso(Date.now()),
  failureList: { ...scan.failures, jobs: failedJobs },
  resumeGapFailures,
  latestRuns,
  linkedin,
  whatsapp,
  codex: { quota: scan.llmUsage?.quota, rateLimits: scan.llmUsage?.rateLimits,
    failedRecentRuns: (scan.llmUsage?.runs || []).filter((run) => run.failedCalls > 0) },
}, null, 2));
