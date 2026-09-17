import { createJobStore } from '../jobs/store.mjs';
import { aggregateGroupStats, aggregateSourcePerformance, STATS_WINDOWS } from '../jobs/insights.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from '../liveness-browser.mjs';

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
  const withStore = (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try { return callback(store); }
    finally { store.close(); }
  };

  const whatsappHistory = (store) => {
    const now = Date.now();
    const all = store.getWhatsAppBacklogStats({ untilMs: now });
    const recent = store.getWhatsAppBacklogStats({ sinceMs: now - 7 * 24 * 60 * 60 * 1_000, untilMs: now });
    const lastRun = store.getLastRunSummary();
    const latestRequest = store.getLatestWhatsAppHistoryRequest();
    const collector = store.getCollectorStatusSummary();
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
        groups: [...knownJids].map((groupJid) => {
          const group = all.groups.find((item) => item.groupJid === groupJid);
          const recentGroup = recentByJid.get(groupJid);
          const name = names.get(groupJid) || 'קבוצה לא מוגדרת';
          const collection = store.getWhatsAppGroupCollectionStats(groupJid);
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
        }),
      },
      request: latestRequest,
    };
  };

  // Rolling-window view across every finished run, not just the last one —
  // a single run's numbers can't tell "which WhatsApp group actually brings
  // jobs" or "is ATS or WhatsApp costing more per suitable job" apart from
  // noise. See scripts/jobs/insights.mjs for how a window is summed.
  const insights = (store) => {
    const now = Date.now();
    const windows = {};
    for (const [key, spanMs] of Object.entries(STATS_WINDOWS)) {
      const runs = store.listRuns({ sinceMs: now - spanMs });
      windows[key] = { groups: aggregateGroupStats(runs), sourcePerformance: aggregateSourcePerformance(runs), runsCounted: runs.length };
    }
    return { windows };
  };

  // What's currently stuck and why — independent of any one run, so it
  // reflects the real outstanding backlog rather than just the last scan.
  const failures = (store) => {
    const breakdown = store.getFailureBreakdown().map((row) => ({
      ...row,
      retryable: !NON_RETRYABLE_FAILURE_CODES.has(row.code),
    }));
    const retryableTotal = breakdown.filter((row) => row.retryable).reduce((sum, row) => sum + row.count, 0);
    const nonRetryableTotal = breakdown.filter((row) => !row.retryable).reduce((sum, row) => sum + row.count, 0);
    return { breakdown, retryableTotal, nonRetryableTotal };
  };

  const snapshot = () => withStore((store) => ({
    ...store.getDashboardSnapshot(),
    collector: store.getCollectorStatusSummary(),
    history: store.diagnosticHistory(),
    action: { ...action },
    settings: dashboardSettings(config),
  }));

  return {
    snapshot,

    summary() {
      return withStore((store) => {
        const stats = store.getDashboardStats();
        return {
          jobs: { suitable: stats.suitable, unopened: stats.unopened },
          companies: store.getCompanyStats(),
          groups: dashboardSettings(config).groups.length,
          action: { status: action.status },
        };
      });
    },

    scan() {
      return withStore((store) => ({
        stats: store.getDashboardStats(),
        lastRun: store.getLastRunSummary(),
        collector: store.getCollectorStatusSummary(),
        action: { ...action },
        settings: dashboardSettings(config),
        whatsappHistory: whatsappHistory(store),
        insights: insights(store),
        failures: failures(store),
      }));
    },

    jobs() {
      return withStore((store) => ({
        stats: store.getDashboardStats(),
        jobs: store.listDashboardJobs(),
      }));
    },

    companies() {
      return withStore((store) => {
        const companies = store.listCompanies({ limit: 500 });
        return { companies, stats: store.getCompanyStats() };
      });
    },

    diagnosticHistory() {
      return withStore((store) => ({ history: store.diagnosticHistory() }));
    },

    diagnosticDetail(kind, id) {
      return withStore((store) => {
        const detail = kind === 'runs'
          ? store.getRun(id)
          : kind === 'actions' ? store.getAction(id) : store.getCollectorRun(id);
        return detail ? { statusCode: 200, payload: { detail } }
          : { statusCode: 404, payload: { error: 'רשומת האבחון לא נמצאה' } };
      });
    },
  };
}
