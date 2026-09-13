import { createJobStore } from '../jobs/store.mjs';

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
            collectedTotal: collection.totalCollected,
            lastRunAt: lastRun?.finished_at || lastRun?.started_at || null,
            received: Number(runGroup?.coverage?.delivered ?? runGroup?.messages ?? 0),
            links: Number(processing?.links ?? runGroup?.candidates ?? 0),
            suitable: Number(processing?.suitable || 0),
            notSuitable: Number(processing?.notSuitable || 0),
            coverage: runGroup?.coverage?.status || null,
            historyStatus: historyGroup?.status || null,
            historyReason: historyGroup?.reason || null,
            historyReceived: Number(historyGroup?.delivered || 0),
            historyRequestedFrom: historyGroup?.requestedFrom ?? null,
          };
        }),
      },
      request: latestRequest,
    };
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
