import { loadCandidateContext } from './candidate-context.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const REJECTED_WINDOW_DAYS = 14;
const REJECTED_LIMIT = 200;
const USAGE_WINDOW_DAYS = 30;

const rejectedSince = (now) => now - REJECTED_WINDOW_DAYS * DAY_MS;

// Rejections from before the import reflect older edits nobody is asking about.
// Offering them unprompted would suggest spending quota for no decision made here.
async function hasChangedSinceImport(store, userId, profileHash) {
  return profileHash !== await store.getImportedScoringHash(userId);
}

// What re-scoring would cost, shown before anyone spends AI quota. Rejected jobs
// kept no text, so they are read from their source again, up to a limit.
export async function estimateRescore({ store, config, userId, now = Date.now() }) {
  const { profileHash } = await loadCandidateContext({ store, config, userId });
  const outdated = await store.countOutdatedVerdicts(profileHash, { rejectedSince: rejectedSince(now) });
  if (!await hasChangedSinceImport(store, userId, profileHash)) outdated.rejected = 0;
  const tokensPerJob = await store.averageScoringTokensPerJob({ since: now - USAGE_WINDOW_DAYS * DAY_MS });
  const rejected = Math.min(outdated.rejected, REJECTED_LIMIT);
  return {
    active: outdated.active,
    rejected,
    rejectedCapped: outdated.rejected > REJECTED_LIMIT,
    rejectedWindowDays: REJECTED_WINDOW_DAYS,
    requested: outdated.requested,
    estimatedTokens: tokensPerJob == null ? null : { active: outdated.active * tokensPerJob, rejected: rejected * tokensPerJob },
  };
}

export async function requestRescore({ store, config, userId, includeRejected = false, now = Date.now() }) {
  const { profileHash } = await loadCandidateContext({ store, config, userId });
  const withRejected = includeRejected && await hasChangedSinceImport(store, userId, profileHash);
  return await store.requestRescore(profileHash, {
    rejectedSince: withRejected ? rejectedSince(now) : null,
    rejectedLimit: REJECTED_LIMIT,
    at: now,
  });
}
