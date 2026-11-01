// What a user may set about their own search. Nothing outside this list can be
// stored, so operational values (rate limits, paths, criteriaVersion) stay out.
// A stored value overrides config/jobs.yml, which overrides the code default.

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw new Error('Expected true or false');
  return value;
}

function requireScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error('Expected a score between 0 and 5');
  }
  return value;
}

export const USER_SETTINGS = Object.freeze({
  'notifications.whatsapp.enabled': { validate: requireBoolean, fallback: false },
  'notifications.whatsapp.minScore': { validate: requireScore, fallback: 4 },
});

function definitionOf(key) {
  if (!Object.hasOwn(USER_SETTINGS, key)) {
    throw Object.assign(new Error('Unknown setting'), { statusCode: 400, code: 'unknown_setting' });
  }
  return USER_SETTINGS[key];
}

function configValue(config, key) {
  return key.split('.').reduce((value, part) => value?.[part], config);
}

export async function saveUserSetting(store, userId, key, value) {
  const definition = definitionOf(key);
  let valid;
  try {
    valid = definition.validate(value);
  } catch (error) {
    throw Object.assign(new Error(`Invalid value for ${key}: ${error.message}`), { statusCode: 400, code: 'invalid_setting' });
  }
  await store.saveUserSetting(userId, key, valid);
  return valid;
}

// A stored value that no longer validates, or a key since removed, is ignored
// rather than handed to the scan.
export async function resolveUserSettings(store, userId, config) {
  const stored = await store.listUserSettings(userId);
  return Object.fromEntries(Object.entries(USER_SETTINGS).map(([key, definition]) => {
    let value = configValue(config, key) ?? definition.fallback;
    if (Object.hasOwn(stored, key)) {
      try { value = definition.validate(stored[key]); } catch { /* Falls back to config or the default. */ }
    }
    return [key, value];
  }));
}
