#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR } from './jobs/config.mjs';

const COPIES = [
  ['config/jobs.example.yml', 'config/jobs.yml'],
  ['templates/candidate-profile.example.md', 'profile/01-candidate-profile.md'],
  ['templates/preferences.example.md', 'profile/02-preferences.md'],
];
const DIRECTORIES = ['auth', 'data', 'documents', 'profile', 'reports'];

export function setupProject({ rootDir = ROOT_DIR } = {}) {
  const created = [];
  const skipped = [];
  const directories = [];
  for (const relativeDir of DIRECTORIES) {
    const directory = path.join(rootDir, relativeDir);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      directories.push(relativeDir);
    }
  }
  for (const [source, target] of COPIES) {
    const sourcePath = path.join(rootDir, source);
    const targetPath = path.join(rootDir, target);
    if (fs.existsSync(targetPath)) {
      skipped.push(target);
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    created.push(target);
  }
  return { created, skipped, directories };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = setupProject();
    console.log('jobOps setup הושלם.');
    if (result.created.length) console.log(`נוצרו: ${result.created.join(', ')}`);
    if (result.skipped.length) console.log(`לא נדרסו קבצים קיימים: ${result.skipped.join(', ')}`);
    console.log('השלב הבא: מלא את קובצי הפרופיל וההעדפות, עדכן config/jobs.yml והריץ npm run doctor.');
  } catch (error) {
    console.error(`setup נכשל: ${error.message}`);
    process.exitCode = 1;
  }
}
