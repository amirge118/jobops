// What a user may set about their own search. Nothing outside this list can be
// stored, so operational values (rate limits, paths, criteriaVersion) stay out.
// A key is the setting's path in the config object, and a stored value overrides
// config/jobs.yml, which overrides the code default.

import { normalizeLinkedInSearch } from './store/repositories/linkedin.mjs';

const MAX_LIST_ITEMS = 200;
const MAX_TEXT_CHARS = 200;

function text(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS || /[\r\n]/.test(value)) throw new Error(`Expected one line of up to ${MAX_TEXT_CHARS} characters`);
  return value.trim();
}

function list(value) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Error(`Expected a list of up to ${MAX_LIST_ITEMS} items`);
  return [...new Set(value.map(text).filter(Boolean))];
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new Error('Expected true or false');
  return value;
}

function score(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) throw new Error('Expected a score between 0 and 5');
  return value;
}

// Each search adds requests, and blocking risks the whole LinkedIn source, so the
// number of searches is limited here, while rate limits stay out of settings.
const MAX_LINKEDIN_SEARCHES = 6;

function linkedinSearches(value) {
  if (!Array.isArray(value) || value.length > MAX_LINKEDIN_SEARCHES) throw new Error(`Expected up to ${MAX_LINKEDIN_SEARCHES} searches`);
  const searches = value.map((search) => {
    const { key, label, keywords, location, geoId } = normalizeLinkedInSearch(search);
    if (!key) throw new Error('Every search needs a key');
    return { key, label, keywords, ...(location ? { location } : {}), ...(geoId ? { geoId } : {}), ...(search.titleIncludes?.length ? { titleIncludes: list(search.titleIncludes) } : {}) };
  });
  if (new Set(searches.map(({ key }) => key)).size !== searches.length) throw new Error('Search keys must be unique');
  return searches;
}

function whatsappGroups(value) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Error(`Expected a list of up to ${MAX_LIST_ITEMS} groups`);
  return value.map(({ name, jid }) => {
    if (typeof jid !== 'string' || !/^[0-9-]+@g\.us$/.test(jid)) throw new Error('Invalid group');
    return { name: text(name), jid };
  });
}

function oneOf(...allowed) {
  return (value) => {
    if (!allowed.includes(value)) throw new Error(`Expected one of: ${allowed.join(', ')}`);
    return value;
  };
}

export const USER_SETTINGS = Object.freeze({
  'filters.domains': list,
  'filters.acceptedLocations': list,
  'filters.preferredSectors': list,
  'decision.minimumScore': score,
  'decision.exactMatchScore': score,
  'notifications.whatsapp.enabled': boolean,
  'notifications.whatsapp.minScore': score,
  'sources.whatsapp.groups': whatsappGroups,
  'sources.whatsapp.markRead': boolean,
  'sources.linkedin.searches': linkedinSearches,
  'sources.linkedin.acceptedAreas': list,
  'search.rolePreset': oneOf('backend', 'generic'),
  'search.focusRole': text,
  'search.excludedRoleTypes': list,
  'search.maxLevel': text,
  'search.levelCapTitles': list,
  'search.avoidPeopleManagement': boolean,
  'search.homeCountry': text,
  'search.titleFilter.positive': list,
  'search.titleFilter.negative': list,
  'search.titleFilter.alwaysAllow': list,
  'search.locationFilter.alwaysAllow': list,
  'search.locationFilter.allow': list,
  'search.locationFilter.block': list,
});

function refuse(code, message) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function validated(key, value) {
  if (!Object.hasOwn(USER_SETTINGS, key)) throw refuse('unknown_setting', 'Unknown setting');
  try {
    return USER_SETTINGS[key](value);
  } catch (error) {
    throw refuse('invalid_setting', `Invalid value for ${key}: ${error.message}`);
  }
}

// A stored value that no longer validates, or a key since removed, is ignored
// rather than handed to the scan.
async function storedSettings(store, userId) {
  const stored = await store.listUserSettings(userId);
  return Object.fromEntries(Object.entries(stored).flatMap(([key, value]) => {
    try {
      return [[key, validated(key, value)]];
    } catch {
      return [];
    }
  }));
}

function withValue(config, key, value) {
  const path = key.split('.');
  const next = { ...config };
  let cursor = next;
  for (const part of path.slice(0, -1)) {
    cursor[part] = { ...cursor[part] };
    cursor = cursor[part];
  }
  cursor[path.at(-1)] = value;
  return next;
}

// All-or-nothing: one bad value saves none of a form's changes.
export async function saveUserSettings(store, userId, values, config = {}) {
  const entries = Object.entries(values).map(([key, value]) => [key, validated(key, value)]);
  const merged = await applyUserSettings(entries.reduce((next, [key, value]) => withValue(next, key, value), config), store, userId, { except: entries.map(([key]) => key) });
  if (Number(merged.decision?.minimumScore) > Number(merged.decision?.exactMatchScore)) {
    throw refuse('invalid_setting', 'The minimum score cannot be above the exact-match score');
  }
  for (const [key, value] of entries) await store.saveUserSetting(userId, key, value);
  return Object.fromEntries(entries);
}

// The config this user's work runs with.
export async function applyUserSettings(config, store, userId, { except = [] } = {}) {
  const stored = await storedSettings(store, userId);
  return Object.entries(stored)
    .filter(([key]) => !except.includes(key))
    .reduce((next, [key, value]) => withValue(next, key, value), config);
}
