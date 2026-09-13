import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';

/**
 * Read the public, reviewable starter catalogue. Dashboard additions remain in
 * SQLite; this function only provides an idempotent bootstrap input.
 */
export function loadConfiguredCompanyEntries(rootDir, portalsPath = process.env.CAREER_OPS_PORTALS) {
  const resolvedPath = path.resolve(rootDir, portalsPath || 'portals.yml');
  if (!fs.existsSync(resolvedPath)) return [];
  const parsed = loadYaml(fs.readFileSync(resolvedPath, 'utf8'));
  return Array.isArray(parsed?.tracked_companies) ? parsed.tracked_companies : [];
}

export function syncConfiguredCompanyEntries(store, rootDir, portalsPath) {
  if (typeof store.importConfiguredCompanies !== 'function') return { imported: 0 };
  return store.importConfiguredCompanies(loadConfiguredCompanyEntries(rootDir, portalsPath));
}
