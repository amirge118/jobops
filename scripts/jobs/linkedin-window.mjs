import { createHash } from 'node:crypto';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Small forward drift (NTP adjustments, a sleeping laptop) is not a reset.
const CLOCK_SKEW_TOLERANCE_MS = 5 * MINUTE;

export const DEFAULT_LINKEDIN_WINDOW = Object.freeze({
  overlapMinutes: 60,
  initialLookbackHours: 24,
  maxBackfillHours: 168,
});

function normalizePart(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cosmetic edits (case, spacing, label) keep coverage; changing what is
// actually asked of LinkedIn starts a new coverage history.
export function linkedinQueryHash({ keywords, location, geoId }) {
  return createHash('sha256')
    .update(JSON.stringify([normalizePart(keywords), normalizePart(location), normalizePart(geoId)]))
    .digest('hex')
    .slice(0, 16);
}

export function linkedinWindowSettings(config = {}) {
  const source = config?.sources?.linkedin || {};
  const pick = (name) => {
    const value = Number(source[name]);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LINKEDIN_WINDOW[name];
  };
  return {
    overlapMinutes: pick('overlapMinutes'),
    initialLookbackHours: pick('initialLookbackHours'),
    maxBackfillHours: pick('maxBackfillHours'),
  };
}

// All values are UTC epoch milliseconds. LinkedIn's f_TPR filter is always
// "the last N seconds", so a window is expressed as `from` with `to = now`;
// an old gap can never be queried on its own, only reached by a wider window.
export function planLinkedInWindow({ coveredUntil = null, mode = 'auto', manualHours = null, settings = DEFAULT_LINKEDIN_WINDOW, now = Date.now() }) {
  const floor = now - settings.maxBackfillHours * HOUR;
  const covered = Number.isFinite(coveredUntil) ? coveredUntil : null;
  const clockSkew = covered != null && covered > now + CLOCK_SKEW_TOLERANCE_MS;

  if (mode === 'manual') {
    const hours = Number(manualHours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('manual LinkedIn window requires positive hours');
    const from = Math.max(now - hours * HOUR, floor);
    // A manual window only extends coverage when it reaches back to it;
    // otherwise it would hide the hole between the two.
    const contiguous = covered == null || clockSkew || from <= covered;
    return { mode, from, to: now, basis: 'manual', contiguous, gap: null, warning: clockSkew ? 'clock_skew' : null };
  }

  if (covered == null) {
    return { mode, from: Math.max(now - settings.initialLookbackHours * HOUR, floor), to: now, basis: 'initial', contiguous: true, gap: null, warning: null };
  }
  if (clockSkew) {
    return { mode, from: Math.max(now - settings.initialLookbackHours * HOUR, floor), to: now, basis: 'clock_reset', contiguous: true, gap: null, warning: 'clock_skew' };
  }
  const desired = covered - settings.overlapMinutes * MINUTE;
  const from = Math.max(desired, floor);
  // After a long shutdown the backfill is capped; the uncovered stretch is
  // reported, not silently absorbed.
  const gap = desired < floor ? { from: covered, to: floor } : null;
  return { mode, from, to: now, basis: 'progress', contiguous: true, gap, warning: null };
}

// Coverage only moves after a complete, persisted collection of a window
// that connects to the previous coverage. Partial or failed runs never
// advance it, so the next run retries the same stretch.
export function nextCoveredUntil({ plan, status, previous = null }) {
  if (status !== 'complete' || !plan?.contiguous) return previous;
  if (plan.warning === 'clock_skew') return plan.to;
  return Math.max(Number(previous) || 0, plan.to);
}
