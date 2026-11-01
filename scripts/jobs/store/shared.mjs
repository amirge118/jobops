// Pure helpers used by more than one repository; none of them touch the database.

import { DECISION_KEYS } from '../decisions.mjs';

export function parseSources(value) {
  try {
    return Array.isArray(JSON.parse(value)) ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

// Calendar day in Israel for a UTC timestamp (YYYY-MM-DD).
export function israelDay(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Number(timestamp)));
}

export function sourceKindOf(source) {
  const value = String(source || '');
  if (/^whatsapp:/i.test(value)) return 'whatsapp';
  if (/^linkedin:/i.test(value)) return 'linkedin';
  if (/^ats:/i.test(value)) return 'ats';
  return 'other';
}

export function sourceMixOf(sources) {
  const mix = {};
  for (const source of sources) {
    const kind = sourceKindOf(source);
    mix[kind] = (mix[kind] || 0) + 1;
  }
  return mix;
}

export function sourceKinds(sources) {
  const kinds = new Set();
  for (const source of sources) {
    if (/^whatsapp:/i.test(source)) kinds.add('whatsapp');
    else if (/^linkedin:/i.test(source)) kinds.add('linkedin');
    else if (/^ats:/i.test(source)) kinds.add('ats');
  }
  return [...kinds];
}

export function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function requiredAuditField(value, name, maxLength = 64) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

export function serializeAuditDetails(details) {
  if (details == null) return null;
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
    throw new Error('run event details exceed 16KB');
  }
  return serialized;
}

export const GAP_TERM_STATUSES = new Set(['in_progress', 'hidden']);

export const JOB_DECISIONS = new Set(DECISION_KEYS);
