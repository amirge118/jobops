import fs from 'node:fs';
import path from 'node:path';

import { load as parseYaml } from 'js-yaml';

function portalFilters(config) {
  try {
    const file = path.join(config.rootDir, 'portals.yml');
    return fs.existsSync(file) ? parseYaml(fs.readFileSync(file, 'utf8')) ?? {} : {};
  } catch {
    return {};
  }
}

const strings = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);

// The free pre-filters in front of scoring. Each list comes from the user's own
// settings when set, otherwise from portals.yml.
export function resolveTitleFilter(config) {
  const { title_filter: portal = {} } = portalFilters(config);
  const own = config.search?.titleFilter ?? {};
  return {
    positive: own.positive ?? strings(portal.positive),
    negative: own.negative ?? strings(portal.negative),
    always_allow: own.alwaysAllow ?? strings(portal.always_allow),
  };
}

export function resolveLocationFilter(config) {
  const { location_filter: portal } = portalFilters(config);
  const own = config.search?.locationFilter ?? {};
  if (!portal && !Object.keys(own).length) return undefined;
  return {
    always_allow: own.alwaysAllow ?? strings(portal?.always_allow),
    allow: own.allow ?? strings(portal?.allow),
    block: own.block ?? strings(portal?.block),
  };
}
