import { createJobStore } from '../jobs/store.mjs';
import { resolveCurrentUser } from '../jobs/current-user.mjs';
import { loadCandidateContext } from '../jobs/candidate/candidate-context.mjs';
import { aggregateGroupStats, aggregateSourcePerformance, STATS_WINDOWS } from '../jobs/insights.mjs';
import { RESUME_GAP_VERSION } from '../jobs/resume-gap.mjs';
import { buildDecisionStats } from '../jobs/decision-stats.mjs';
import { buildSourceValue, SOURCE_VALUE_WINDOW_DAYS } from '../jobs/source-value.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from '../liveness-browser.mjs';
import { linkedinWindowSettings } from '../jobs/linkedin-window.mjs';
import { readCodexRateLimits } from '../jobs/llm-usage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { buildSpeedStats, parseTrackerRows } from '../jobs/speed-stats.mjs';

function readTrackerRows(config) {
  try { return parseTrackerRows(fs.readFileSync(path.join(config.rootDir, 'data', 'applications.md'), 'utf8')); }
  catch { return []; }
}

function safeRateLimits() {
  try { return readCodexRateLimits({ fsModule: fs }); } catch { return null; }
}
import { DEFAULT_LINKEDIN_LIMITS } from '../jobs/sources/linkedin.mjs';

export function dashboardSettings(config) {
  return {
    defaultLookbackDays: Number(config.scan.defaultLookbackDays),
    maxLookbackDays: Number(config.scan.maxLookbackDays),
    minimumScore: Number(config.decision?.minimumScore ?? 4),
    exactMatchScore: Number(config.decision?.exactMatchScore ?? 4.5),
    demo: Boolean(config.demo),
    groups: (config.sources.whatsapp?.groups || []).map(({ name }) => ({ name })),
  };
}

export function createDashboardQueries(config, action) {
  const withStore = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try { return await callback(store); }
    finally { store.close(); }
  };

  const resumeGapContext = async (store) => {
    try {
      const candidate = await loadCandidateContext({ store, config, userId: resolveCurrentUser().id });
      return {
        profileHash: candidate.profileHash, resumeHash: candidate.resumeHash,
        resumeAvailable: candidate.resumeAvailable, analysisVersion: RESUME_GAP_VERSION,
      };
    } catch {
      return {
        profileHash: '', resumeHash: '', resumeAvailable: false,
        analysisVersion: RESUME_GAP_VERSION,
      };
    }
  };

  const whatsappHistory = async (store) => {
    const now = Date.now();
    const all = await store.getWhatsAppBacklogStats({ untilMs: now });
    const recent = await store.getWhatsAppBacklogStats({ sinceMs: now - 7 * 24 * 60 * 60 * 1_000, untilMs: now });
    const lastRun = await store.getLastRunSummary();
    const latestRequest = await store.getLatestWhatsAppHistoryRequest();
    const collector = await store.getCollectorStatusSummary();
    const collectorLive = collector?.status === 'connected' &&
      Number(collector.groups_found || 0) === Number(collector.groups_expected || 0);
    const historyGroups = new Map((latestRequest?.groups || []).map((group) => [group.name, group]));
    const lastWhatsAppGroups = new Map((lastRun?.details?.whatsapp?.groups || []).map((group) => [group.name, group]));
    const processingGroups = new Map((lastRun?.details?.processing?.scopes || [])
      .filter((scope) => scope.source === 'whatsapp').map((scope) => [scope.name, scope]));
    const names = new Map((config.sources.whatsapp?.groups || []).map((group) => [group.jid, group.name]));
    const recentByJid = new Map(recent.groups.map((group) => [group.groupJid, group]));
    const knownJids = new Set([...names.keys(), ...all.groups.map((group) => group.groupJid)]);
    return {
      backlog: {
        total: recent.total,
        expiredTotal: Math.max(0, all.total - recent.total),
        failed: recent.failed,
        recentTotal: recent.total,
        oldestAt: all.oldestAt,
        newestAt: all.newestAt,
        groups: await Promise.all([...knownJids].map(async (groupJid) => {
          const group = all.groups.find((item) => item.groupJid === groupJid);
          const recentGroup = recentByJid.get(groupJid);
          const name = names.get(groupJid) || 'קבוצה לא מוגדרת';
          const collection = await store.getWhatsAppGroupCollectionStats(groupJid);
          const runGroup = lastWhatsAppGroups.get(name);
          const processing = processingGroups.get(name);
          const historyGroup = historyGroups.get(name);
          const historyRunning = ['pending', 'running'].includes(historyGroup?.status);
          const hasGap = ['partial', 'failed'].includes(historyGroup?.status) && Boolean(historyGroup?.reason);
          const syncState = historyRunning ? 'recovering'
            : collectorLive && hasGap ? 'live-with-gap'
              : hasGap ? 'gap'
                : collectorLive ? 'live' : 'offline';
          return {
            name,
            total: Number(recentGroup?.total || 0),
            expiredTotal: Math.max(0, Number(group?.total || 0) - Number(recentGroup?.total || 0)),
            recentTotal: Number(recentGroup?.total || 0),
            failed: Number(processing?.failed ?? recentGroup?.failed ?? 0),
            oldestAt: group?.oldestAt ?? null,
            newestAt: group?.newestAt ?? null,
            lastCollectedAt: collection.lastCollectedAt,
            lastProcessedAt: collection.lastProcessedAt,
            lastReadAt: collection.lastReadAt,
            readTotal: collection.readTotal,
            collectedTotal: collection.totalCollected,
            lastRunAt: lastRun?.finished_at || lastRun?.started_at || null,
            received: Number(runGroup?.coverage?.delivered ?? runGroup?.messages ?? 0),
            links: Number(processing?.links ?? runGroup?.candidates ?? 0),
            processed: Number(processing?.processed || 0),
            filtered: Number(processing?.filtered || 0),
            suitable: Number(processing?.suitable || 0),
            notSuitable: Number(processing?.notSuitable || 0),
            coverage: runGroup?.coverage?.status || null,
            historyStatus: historyGroup?.status || null,
            historyReason: historyGroup?.reason || null,
            historyReceived: Number(historyGroup?.delivered || 0),
            historyRequestedFrom: historyGroup?.requestedFrom ?? null,
            syncState,
            gapFrom: hasGap ? historyGroup?.requestedFrom ?? null : null,
          };
        })),
      },
      request: latestRequest,
    };
  };

  // Rolling-window view across every finished run, not just the last one —
  // a single run's numbers can't tell "which WhatsApp group actually brings
  // jobs" or "is ATS or WhatsApp costing more per suitable job" apart from
  // noise. See scripts/jobs/insights.mjs for how a window is summed.
  const insights = async (store) => {
    const now = Date.now();
    const windows = {};
    for (const [key, spanMs] of Object.entries(STATS_WINDOWS)) {
      const runs = await store.listRuns({ sinceMs: now - spanMs });
      windows[key] = { groups: aggregateGroupStats(runs), sourcePerformance: aggregateSourcePerformance(runs), runsCounted: runs.length };
    }
    return { windows };
  };

  // What's currently stuck and why — independent of any one run, so it
  // reflects the real outstanding backlog rather than just the last scan.
  // Searches are defined only in config/jobs.yml; syncing on read lets the
  // dashboard show them before the first LinkedIn scan has ever run.
  const llmUsage = async (store) => {
    const now = Date.now();
    const day = await store.summarizeCodexUsage({ sinceMs: now - 24 * 60 * 60 * 1000, untilMs: now });
    const week = await store.summarizeCodexUsage({ sinceMs: now - 7 * 24 * 60 * 60 * 1000, untilMs: now });
    return {
      model: config.scoring?.model || 'default',
      reasoningEffort: config.scoring?.reasoningEffort || null,
      quota: day.quota,
      rateLimits: config.demo ? null : safeRateLimits(),
      day: day.totals,
      week: week.totals,
      runs: week.runs,
    };
  };

  const linkedin = async (store) => {
    const configured = config.sources.linkedin || null;
    if (configured) await store.syncLinkedInSearches(configured.searches || []);
    return {
      configured: Boolean(configured),
      configEnabled: Boolean(configured?.enabled),
      enabled: Boolean(configured?.enabled) && await store.isSourceEnabled('linkedin'),
      window: linkedinWindowSettings(config),
      limits: { ...DEFAULT_LINKEDIN_LIMITS, ...(configured?.limits || {}) },
      searches: await store.listLinkedInSearches(),
    };
  };

  // LinkedIn postings waiting for the hourly cap or a cooldown are not
  // failures: the queue reader reads them on its own, and "retry" would only
  // add requests to LinkedIn. They are reported apart as `waiting`.
  const WAITING_CODES = new Set(['linkedin_deferred', 'linkedin_cooldown']);
  const failures = async (store) => {
    const rows = await store.getFailureBreakdown();
    const breakdown = rows.filter((row) => !WAITING_CODES.has(row.code)).map((row) => ({
      ...row,
      retryable: !NON_RETRYABLE_FAILURE_CODES.has(row.code),
    }));
    const retryableTotal = breakdown.filter((row) => row.retryable).reduce((sum, row) => sum + row.count, 0);
    const nonRetryableTotal = breakdown.filter((row) => !row.retryable).reduce((sum, row) => sum + row.count, 0);
    const waiting = { linkedin: rows.filter((row) => WAITING_CODES.has(row.code)).reduce((sum, row) => sum + row.count, 0) };
    return { breakdown, retryableTotal, nonRetryableTotal, waiting };
  };

  const snapshot = async () => await withStore(async (store) => ({
    ...await store.getDashboardSnapshot(),
    collector: await store.getCollectorStatusSummary(),
    history: await store.diagnosticHistory(),
    action: { ...action },
    settings: dashboardSettings(config),
  }));

  return {
    snapshot,

    async summary() {
      return await withStore(async (store) => {
        const stats = await store.getDashboardStats();
        return {
          jobs: { suitable: stats.suitable, unopened: stats.unopened },
          companies: await store.getCompanyStats(),
          groups: dashboardSettings(config).groups.length,
          action: { status: action.status },
        };
      });
    },

    async scan() {
      return await withStore(async (store) => ({
        stats: await store.getDashboardStats(),
        lastRun: await store.getLastRunSummary(),
        collector: await store.getCollectorStatusSummary(),
        action: { ...action },
        settings: dashboardSettings(config),
        whatsappHistory: await whatsappHistory(store),
        insights: await insights(store),
        failures: await failures(store),
        linkedin: await linkedin(store),
        llmUsage: await llmUsage(store),
      }));
    },

    async linkedin() {
      return await withStore(async (store) => await linkedin(store));
    },

    async dailyLlmUsage(days = 14) {
      return await withStore(async (store) => ({
        model: config.scoring?.model || 'default',
        ...await store.dailyUsageBySource({ days: Math.max(1, Math.min(60, Number(days) || 14)) }),
      }));
    },

    async setLinkedInEnabled(enabled) {
      return await withStore(async (store) => { await store.setSourceEnabled('linkedin', enabled); return await linkedin(store); });
    },

    async jobs() {
      return await withStore(async (store) => ({
        stats: await store.getDashboardStats(),
        jobs: await store.listDashboardJobs({ resumeGapContext: await resumeGapContext(store) }),
      }));
    },

    async decisionStats() {
      return await withStore(async (store) => ({
        ...buildDecisionStats(await store.listJobDecisions(), {
          pending: (await store.getDashboardStats()).suitable,
          minimumScore: Number(config.decision?.minimumScore ?? 4),
          exactMatchScore: Number(config.decision?.exactMatchScore ?? 4.5),
        }),
        sourceValue: buildSourceValue(await store.listSourceValueFacts({
          since: Date.now() - SOURCE_VALUE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
        })),
        speed: buildSpeedStats({
          decisions: await store.listJobDecisions(),
          sightings: await store.listSightingTimes(),
          linkedinPostings: await store.listLinkedInPostingTimes({ since: Date.now() - SOURCE_VALUE_WINDOW_DAYS * 24 * 60 * 60 * 1_000 }),
          watchedCompanies: (await store.listCompanies({ status: 'watched', limit: 1_000 })).map((company) => company.name),
          trackerRows: readTrackerRows(config),
        }),
      }));
    },

    async companies() {
      return await withStore(async (store) => {
        const companies = await store.listCompanies({ limit: 500 });
        return { companies, stats: await store.getCompanyStats() };
      });
    },

    async diagnosticHistory() {
      return await withStore(async (store) => ({ history: await store.diagnosticHistory() }));
    },

    async diagnosticDetail(kind, id) {
      return await withStore(async (store) => {
        const detail = kind === 'runs'
          ? await store.getRun(id)
          : kind === 'actions' ? await store.getAction(id) : await store.getCollectorRun(id);
        return detail ? { statusCode: 200, payload: { detail } }
          : { statusCode: 404, payload: { error: 'רשומת האבחון לא נמצאה' } };
      });
    },
  };
}
