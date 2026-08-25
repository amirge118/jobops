import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const JOBS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(JOBS_DIR, '..', '..');

function requiredFile(filePath, hint) {
  if (!fs.existsSync(filePath)) throw new Error(`${hint}: ${filePath}`);
  return filePath;
}

export function loadJobsConfig(configPath = process.env.JOBOPS_JOBS_CONFIG) {
  const resolvedPath = path.resolve(configPath || path.join(ROOT_DIR, 'config', 'jobs.yml'));
  requiredFile(resolvedPath, 'Missing unified jobs config');
  const config = loadYaml(fs.readFileSync(resolvedPath, 'utf8'));

  if (!config?.scan || !config?.sources || !config?.filters || !config?.decision) {
    throw new Error('config/jobs.yml must define scan, sources, filters, and decision');
  }

  config.rootDir = ROOT_DIR;
  config.configPath = resolvedPath;
  config.dataDir = path.join(ROOT_DIR, 'data');
  config.reportsDir = path.join(ROOT_DIR, 'reports', 'daily');
  config.pipelinePath = path.join(ROOT_DIR, 'data', 'pipeline.md');
  config.jobsDbPath = path.join(ROOT_DIR, 'data', 'jobs.db');
  const whatsapp = config.sources.whatsapp;
  if (whatsapp?.authPath) whatsapp.authAbsPath = path.resolve(ROOT_DIR, whatsapp.authPath);

  return config;
}

export function readCandidateContext(config) {
  const profilePath = requiredFile(
    path.join(config.rootDir, 'profile', '01-candidate-profile.md'),
    'Missing candidate profile',
  );
  const preferencesPath = requiredFile(
    path.join(config.rootDir, 'profile', '02-preferences.md'),
    'Missing candidate preferences',
  );
  const profile = fs.readFileSync(profilePath, 'utf8');
  const preferences = fs.readFileSync(preferencesPath, 'utf8');
  const profileHash = createHash('sha256')
    .update(profile)
    .update('\n--- preferences ---\n')
    .update(preferences)
    .digest('hex');
  return { profile, preferences, profileHash };
}
