// Rolling-window aggregation over already-finished runs' stored per-run
// breakdowns (summarizeProcessingResults / summarizeSourceResults in
// jobs.mjs). No new event stream is needed: every finished run already
// carries everything these need in its own details_json, so summing across
// a window is just arithmetic over store.listRuns(...).

const HOUR_MS = 60 * 60 * 1_000;
export const STATS_WINDOWS = { '36h': 36 * HOUR_MS, '7d': 7 * 24 * HOUR_MS };

// Per WhatsApp group: how many messages actually came in, and what happened
// to the links extracted from them, over the window — the "who really
// brings jobs" view a single run's numbers can't answer on their own.
export function aggregateGroupStats(runs) {
  const groups = new Map();
  const rowFor = (name) => {
    let row = groups.get(name);
    if (!row) {
      row = { name, received: 0, processed: 0, suitable: 0, notSuitable: 0, filtered: 0, failed: 0, runs: 0 };
      groups.set(name, row);
    }
    return row;
  };
  for (const run of runs) {
    const details = run.details || {};
    for (const group of details.whatsapp?.groups || []) {
      const row = rowFor(group.name);
      row.received += Number(group.coverage?.delivered ?? group.messages ?? 0);
      row.runs += 1;
    }
    for (const scope of details.processing?.scopes || []) {
      if (scope.source !== 'whatsapp') continue;
      const row = rowFor(scope.name);
      row.processed += Number(scope.processed || 0);
      row.suitable += Number(scope.suitable || 0);
      row.notSuitable += Number(scope.notSuitable || 0);
      row.filtered += Number(scope.filtered || 0);
      row.failed += Number(scope.failed || 0);
    }
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'he'));
}

// ATS vs WhatsApp: how many links each source actually sent to Codex for
// scoring ("processed"), and how many of those turned out suitable — the
// simplest honest proxy for "cost per suitable job" per source. Items a
// local filter screened out before ever reaching Codex are excluded from
// both sides of that ratio on purpose (they cost nothing to screen).
export function aggregateSourcePerformance(runs) {
  const totals = {
    ats: { processed: 0, suitable: 0, notSuitable: 0, filtered: 0, failed: 0 },
    whatsapp: { processed: 0, suitable: 0, notSuitable: 0, filtered: 0, failed: 0 },
  };
  for (const run of runs) {
    for (const scope of run.details?.processing?.scopes || []) {
      const bucket = totals[scope.source];
      if (!bucket) continue;
      bucket.processed += Number(scope.processed || 0);
      bucket.suitable += Number(scope.suitable || 0);
      bucket.notSuitable += Number(scope.notSuitable || 0);
      bucket.filtered += Number(scope.filtered || 0);
      bucket.failed += Number(scope.failed || 0);
    }
  }
  const withCost = (bucket) => ({
    ...bucket,
    costPerSuitable: bucket.suitable > 0 ? Number((bucket.processed / bucket.suitable).toFixed(1)) : null,
  });
  return { ats: withCost(totals.ats), whatsapp: withCost(totals.whatsapp) };
}
