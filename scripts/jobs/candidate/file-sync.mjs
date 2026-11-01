import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { rawProfileHash } from '../config.mjs';
import { applyUserSettings } from '../user-settings.mjs';
import { canonicalScoringHash, scoringCriteria } from './scoring-hash.mjs';

// The documents live in the database. profile/*.md stay as a copy for the
// skills that read them, and as the way in for what was there before. The demo
// shares the real project folder and must never read or write these files.
export const DOCUMENT_FILES = Object.freeze({
  profile: 'profile/01-candidate-profile.md',
  preferences: 'profile/02-preferences.md',
  resume: 'profile/03-current-resume.md',
  stories: 'data/story-bank.md',
});
export const DOCUMENT_KINDS = Object.freeze(Object.keys(DOCUMENT_FILES));
const COPY_FILES = Object.freeze({ ...DOCUMENT_FILES, applications: 'data/applications.md' });

const hashOf = (content) => createHash('sha256').update(content).digest('hex');

function filePath(config, kind) {
  return path.join(config.rootDir, COPY_FILES[kind]);
}

function readFile(config, kind) {
  const file = filePath(config, kind);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export async function importMissingFromFiles({ store, config, userId }) {
  if (config.demo) return [];
  const missing = [];
  for (const kind of DOCUMENT_KINDS) {
    if (await store.getCurrentDocument(userId, kind)) continue;
    const content = readFile(config, kind);
    if (content?.trim()) missing.push({ kind, content });
  }
  if (!missing.length) return [];

  // Scores already stored carry the hash of the raw files. Linking it to the
  // canonical hash keeps them current, without re-scoring anything.
  const byKind = Object.fromEntries(missing.map(({ kind, content }) => [kind, content]));
  const criteria = scoringCriteria(await applyUserSettings(config, store, userId));
  const alias = byKind.profile !== undefined && byKind.preferences !== undefined
    ? { canonicalHash: canonicalScoringHash(byKind.profile, byKind.preferences, criteria), storedHash: rawProfileHash(byKind.profile, byKind.preferences) }
    : null;
  const imported = await store.importMissingDocuments(userId, missing, { alias });
  for (const { kind, content } of missing) {
    if (imported.includes(kind)) await store.saveProfileFileExport(userId, kind, hashOf(content));
  }
  return imported;
}

// A file that changed since our last write was edited by hand or by a skill.
export async function driftedKinds({ store, config, userId }) {
  if (config.demo) return [];
  const drifted = [];
  for (const kind of DOCUMENT_KINDS) {
    if (await fileHasDrifted({ store, config, userId }, kind)) drifted.push(kind);
  }
  return drifted;
}

// A hand edit is never overwritten. It waits until the person adopts or discards it.
export async function exportDocument({ store, config, userId }, { kind, content }) {
  if (config.demo) return 'skipped';
  const onDisk = readFile(config, kind);
  const exported = await store.getProfileFileExport(userId, kind);
  if (onDisk !== null && exported !== null && hashOf(onDisk) !== exported && onDisk !== content) return 'conflict';
  const file = filePath(config, kind);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Nothing was created. */ }
    console.error(`Could not write the ${kind} file: ${error.code || 'unknown error'}`);
    return 'failed';
  }
  await store.saveProfileFileExport(userId, kind, hashOf(content));
  return 'written';
}

export async function fileHasDrifted({ store, config, userId }, kind) {
  if (config.demo) return false;
  const content = readFile(config, kind);
  const exported = await store.getProfileFileExport(userId, kind);
  return content !== null && exported !== null && hashOf(content) !== exported;
}

export function readDocumentFile(config, kind) {
  return config.demo ? null : readFile(config, kind);
}

export async function markFileExported({ store, userId }, kind, content) {
  await store.saveProfileFileExport(userId, kind, hashOf(content));
}
