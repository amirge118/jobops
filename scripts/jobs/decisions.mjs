// What each Decisions-page button means, in one place, for every reader:
// statistics, score calibration, source value, and resume-gap weighting.

// 'interested' is no longer offered (replaced by 'applied'); older decisions keep it.
export const DECISION_KEYS = [
  'applied', 'interested', 'company_candidate',
  'not_interested', 'not_relevant', 'too_senior', 'company_not_interesting',
];

// The job or its company was wanted.
export const POSITIVE_DECISIONS = new Set(['applied', 'interested', 'company_candidate']);

// The user wanted this very job (company_candidate is about the company only).
export const WANTED_JOB_DECISIONS = new Set(['applied', 'interested']);

// The scorer misjudged the role itself. Every other "no" (the role fits but
// this job or company does not appeal) is a preference, not a scoring miss,
// so its requirements still count at full weight as demand for the person.
export const SCORE_MISS_DECISIONS = new Set(['not_relevant', 'too_senior']);
