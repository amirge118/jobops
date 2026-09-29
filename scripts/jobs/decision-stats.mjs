// Statistics over what the user did with jobs shown on the Decisions page
// (store.listJobDecisions). Pure arithmetic over the stored snapshots, so it
// can be tested without a database and recomputed on every dashboard load.

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DECISION_WINDOWS = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, all: Infinity };
export const DECISION_KEYS = ['interested', 'company_candidate', 'company_not_interesting', 'too_senior', 'not_relevant'];
const POSITIVE = new Set(['interested', 'company_candidate']);
// The threshold before the 3.6 trial; jobs scored below it exist only
// because of the trial, so their outcome is what decides whether to keep it.
const LEGACY_MINIMUM_SCORE = 4.0;
const RECENT_LIMIT = 20;
const COMPANY_LIMIT = 10;

function emptyCounts() {
  return Object.fromEntries(DECISION_KEYS.map((key) => [key, 0]));
}

function summarize(decisions) {
  const byDecision = emptyCounts();
  for (const item of decisions) if (item.decision in byDecision) byDecision[item.decision] += 1;
  const positive = decisions.filter((item) => POSITIVE.has(item.decision)).length;
  return { total: decisions.length, positive, byDecision };
}

// The trial band also covers scores below the current threshold, so jobs
// decided while it was lower stay visible after it is raised back.
function scoreBands(minimumScore, exactMatchScore, lowestScore) {
  const bands = [];
  const trialFrom = Math.min(minimumScore, lowestScore);
  if (trialFrom < LEGACY_MINIMUM_SCORE) {
    bands.push({ key: 'trial', from: trialFrom, to: LEGACY_MINIMUM_SCORE });
  }
  const middleFrom = Math.max(minimumScore, LEGACY_MINIMUM_SCORE);
  if (middleFrom < exactMatchScore) bands.push({ key: 'fit', from: middleFrom, to: exactMatchScore });
  bands.push({ key: 'exact', from: exactMatchScore, to: Infinity });
  return bands;
}

function groupRate(decisions, keyOf) {
  const groups = new Map();
  for (const item of decisions) {
    for (const key of keyOf(item)) {
      const row = groups.get(key) || { key, total: 0, positive: 0 };
      row.total += 1;
      if (POSITIVE.has(item.decision)) row.positive += 1;
      groups.set(key, row);
    }
  }
  return [...groups.values()];
}

export function buildDecisionStats(decisions, {
  now = Date.now(),
  pending = 0,
  minimumScore = LEGACY_MINIMUM_SCORE,
  exactMatchScore = 4.5,
} = {}) {
  const sorted = [...decisions].sort((left, right) => right.decidedAt - left.decidedAt);
  const windows = Object.fromEntries(Object.entries(DECISION_WINDOWS).map(([key, span]) => [
    key,
    summarize(sorted.filter((item) => now - item.decidedAt <= span)),
  ]));

  const scored = sorted.filter((item) => Number.isFinite(item.score));
  const lowestScore = Math.min(Infinity, ...scored.map((item) => item.score));
  const bands = scoreBands(Number(minimumScore), Number(exactMatchScore), lowestScore).map((band) => {
    const inBand = scored.filter((item) => item.score >= band.from && item.score < band.to);
    return { ...band, to: Number.isFinite(band.to) ? band.to : null, ...summarize(inBand) };
  });

  const sources = groupRate(sorted, (item) => (item.sourceKinds?.length ? item.sourceKinds : ['unknown']))
    .sort((left, right) => right.total - left.total);

  const companies = new Map();
  for (const item of sorted) {
    if (item.decision !== 'company_not_interesting' || !item.company) continue;
    companies.set(item.company, (companies.get(item.company) || 0) + 1);
  }

  const calibration = {
    // Scorer said the level fits (seniority >= 4) but the user said too senior.
    tooSeniorDespiteFit: sorted.filter((item) => item.decision === 'too_senior' && Number(item.fit?.seniority) >= 4).length,
    tooSeniorTotal: windows.all.byDecision.too_senior,
    // Scorer said the role is mainly the right work, the user disagreed.
    notRelevantDespiteFit: sorted.filter((item) => item.decision === 'not_relevant' &&
      (Number(item.fit?.roleScope) >= 4 || Number(item.fit?.cvMatch) >= 4)).length,
    notRelevantTotal: windows.all.byDecision.not_relevant,
    // Wanted jobs that only exist because of the lowered threshold.
    positiveBelowLegacy: scored.filter((item) => POSITIVE.has(item.decision) && item.score < LEGACY_MINIMUM_SCORE).length,
    totalBelowLegacy: scored.filter((item) => item.score < LEGACY_MINIMUM_SCORE).length,
  };

  return {
    pending: Number(pending) || 0,
    windows,
    scoreBands: bands,
    sources,
    calibration,
    rejectedCompanies: [...companies.entries()]
      .map(([company, count]) => ({ company, count }))
      .sort((left, right) => right.count - left.count || left.company.localeCompare(right.company))
      .slice(0, COMPANY_LIMIT),
    recent: sorted.slice(0, RECENT_LIMIT).map((item) => ({
      jobKey: item.jobKey,
      decision: item.decision,
      decidedAt: item.decidedAt,
      company: item.company,
      title: item.title,
      score: item.score,
      applyUrl: POSITIVE.has(item.decision) ? item.applyUrl : null,
    })),
  };
}
