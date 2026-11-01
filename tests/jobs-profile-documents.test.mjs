import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { readCandidateContext } from '../scripts/jobs/config.mjs';
import { LOCAL_USER_ID as USER } from '../scripts/jobs/current-user.mjs';
import { loadCandidateContext } from '../scripts/jobs/candidate/candidate-context.mjs';
import * as serverSections from '../scripts/jobs/candidate/document-sections.mjs';
import { driftedKinds } from '../scripts/jobs/candidate/file-sync.mjs';
import { applyIdentity, parseIdentity } from '../scripts/jobs/candidate/identity-section.mjs';
import { createProfileService } from '../scripts/jobs/candidate/profile-service.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';
import * as browserSections from '../web/shared/document-sections.js';

const PROFILE = `# Candidate Profile
<!-- Updated from the CV -->

## Identity
- **Name:** Noa Example
- **Phone:** 050-0000000
- **Custom:** kept as is

## Professional Summary
Backend engineer.


## Skills   
Node.js
`;
const PREFERENCES = '# Preferences\n\n## Target Roles\nBackend\n';
const RESUME = '# Noa Example\n\n## Experience\nBackend engineer at Acme, building APIs.\n';

function setup(context, { files = true, demo = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-profile-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  if (files) {
    fs.mkdirSync(path.join(rootDir, 'profile'));
    fs.writeFileSync(path.join(rootDir, 'profile', '01-candidate-profile.md'), PROFILE);
    fs.writeFileSync(path.join(rootDir, 'profile', '02-preferences.md'), PREFERENCES);
    fs.writeFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), RESUME);
  }
  const config = { rootDir, jobsDbPath: path.join(rootDir, 'jobs.db'), demo };
  const store = createJobStore(config.jobsDbPath);
  context.after(() => store.close());
  return { store, config, rootDir, service: createProfileService({ store, config, userId: USER }), load: () => loadCandidateContext({ store, config, userId: USER }) };
}

const fileText = (rootDir, name) => fs.readFileSync(path.join(rootDir, 'profile', name), 'utf8');

test('sections are a view: split and join always give back the exact text', () => {
  const samples = [PROFILE, '', 'no headings\n', '## first\r\nbody\r\n## second', '\n\n## a\n\n\n## b\n', 'א\n## כותרת בעברית\nטקסט\n'];
  for (const text of samples) {
    assert.equal(serverSections.joinSections(serverSections.splitSections(text)), text);
    assert.deepEqual(browserSections.splitSections(text), serverSections.splitSections(text), 'the browser copy parses the same');
  }
});

test('moving from files keeps the stored scoring hash, so nothing looks out of date', async (context) => {
  const { load, config } = setup(context);
  const before = readCandidateContext(config);
  const after = await load();
  assert.equal(after.profileHash, before.profileHash);
  assert.equal(after.resumeHash, before.resumeHash);
  assert.equal(after.profile, PROFILE);
  assert.equal(after.preferences, PREFERENCES);
  assert.equal(after.currentResume, RESUME);
  assert.equal(after.resumeAvailable, true);
  assert.deepEqual(after.fileDrift, []);
  assert.equal((await load()).profileHash, before.profileHash, 'and stays so on later loads');
});

test('contact details and comments do not change the scoring hash; content does', async (context) => {
  const { load, service, store } = setup(context);
  const original = (await load()).profileHash;
  const { documents } = await service.overview();
  await service.saveIdentity({ phone: '052-1111111' }, { baseVersion: documents.profile.version });
  assert.equal((await load()).profileHash, original, 'a new phone number');

  let current = await store.getCurrentDocument(USER, 'profile');
  await service.saveDocument('profile', `${current.content}<!-- a note -->\n`, { baseVersion: current.version });
  assert.equal((await load()).profileHash, original, 'a comment');

  current = await store.getCurrentDocument(USER, 'profile');
  await service.saveDocument('profile', `${current.content}\n## New\nLed a team.\n`, { baseVersion: current.version });
  assert.notEqual((await load()).profileHash, original, 'a real change');
});

test('undoing a change returns to the same hash, so verdicts count again', async (context) => {
  const { load, service, store } = setup(context);
  const original = (await load()).profileHash;
  const first = await store.getCurrentDocument(USER, 'preferences');
  await service.saveDocument('preferences', `${PREFERENCES}Remote only.\n`, { baseVersion: first.version });
  assert.notEqual((await load()).profileHash, original);
  await service.restoreVersion('preferences', first.version, { baseVersion: first.version + 1 });
  assert.equal((await load()).profileHash, original);
});

test('identity edits only their own lines and keeps everything else', () => {
  const updated = applyIdentity(PROFILE, { phone: '052-1', email: 'noa@example.com', name: '' });
  const identity = parseIdentity(updated);
  assert.equal(identity.phone, '052-1');
  assert.equal(identity.email, 'noa@example.com');
  assert.equal(identity.name, '');
  assert.match(updated, /- \*\*Custom:\*\* kept as is/);
  assert.match(updated, /<!-- Updated from the CV -->/);
  assert.ok(updated.endsWith('## Skills   \nNode.js\n'));
  assert.equal(applyIdentity(PROFILE, {}), PROFILE, 'no fields, no change');
  assert.equal(applyIdentity(PROFILE, parseIdentity(PROFILE)).includes('Custom'), true);
});

test('identity values are single lines from a known list', () => {
  assert.throws(() => applyIdentity(PROFILE, { phone: 'x\n## Injected' }), /one line/);
  assert.throws(() => applyIdentity(PROFILE, { password: 'x' }), /Unknown identity field/);
  assert.throws(() => applyIdentity(PROFILE, { phone: 5 }), /must be text/);
  assert.throws(() => applyIdentity(PROFILE, { name: 'x'.repeat(201) }), /one line/);
  const tricky = applyIdentity(PROFILE, { name: '$& $1 cost' });
  assert.equal(parseIdentity(tricky).name, '$& $1 cost', 'replacement patterns stay literal');
});

test('saving keeps versions, refuses a stale editor, and ignores no-op saves', async (context) => {
  const { service } = setup(context);
  const { documents } = await service.overview();
  const base = documents.resume.version;
  const saved = await service.saveDocument('resume', `${RESUME}More.\n`, { baseVersion: base });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.document.version, base + 1);
  await assert.rejects(service.saveDocument('resume', 'other tab', { baseVersion: base }), { statusCode: 409, code: 'version_conflict' });
  const same = await service.saveDocument('resume', `${RESUME}More.\n`, { baseVersion: base + 1 });
  assert.equal(same.status, 'unchanged');
  assert.equal((await service.listVersions('resume')).length, 2);
  await service.restoreVersion('resume', base, { baseVersion: base + 1 });
  assert.equal((await service.getVersion('resume', base + 2)).content, RESUME);
});

test('bad documents are refused', async (context) => {
  const { service } = setup(context);
  for (const content of ['', '   ', 5, null, 'a\u0000b']) {
    await assert.rejects(service.saveDocument('resume', content, { baseVersion: null }), { statusCode: 400 }, String(content));
  }
  await assert.rejects(service.saveDocument('resume', 'x'.repeat(200_001), { baseVersion: null }), { statusCode: 413 });
  await assert.rejects(service.saveDocument('resume', 'ok', { baseVersion: 'x' }), { code: 'invalid_version' });
});

test('old versions are pruned, per kind', async (context) => {
  const { service, store } = setup(context);
  await service.overview();
  for (let index = 0; index < 55; index += 1) {
    const current = await store.getCurrentDocument(USER, 'resume');
    await service.saveDocument('resume', `${RESUME}${index}\n`, { baseVersion: current.version });
  }
  const versions = await service.listVersions('resume');
  assert.equal(versions.length, 50);
  assert.equal(versions[0].version, 56);
  assert.equal((await service.listVersions('profile')).length, 1);
});

test('saves reach the file copy, and a hand edit is never overwritten', async (context) => {
  const { service, store, rootDir, config, load } = setup(context);
  await service.overview();
  let current = await store.getCurrentDocument(USER, 'resume');
  const saved = await service.saveDocument('resume', `${RESUME}Edited.\n`, { baseVersion: current.version });
  assert.equal(saved.fileCopy, 'written');
  assert.equal(fileText(rootDir, '03-current-resume.md'), `${RESUME}Edited.\n`);

  fs.writeFileSync(path.join(rootDir, 'profile', '03-current-resume.md'), 'hand edit\n');
  assert.deepEqual(await driftedKinds({ store, config, userId: USER }), ['resume']);
  assert.deepEqual((await load()).fileDrift, ['resume']);
  assert.equal((await load()).currentResume, `${RESUME}Edited.\n`, 'the document stays authoritative');

  current = await store.getCurrentDocument(USER, 'resume');
  const blocked = await service.saveDocument('resume', `${RESUME}Later.\n`, { baseVersion: current.version });
  assert.equal(blocked.fileCopy, 'conflict');
  assert.equal(fileText(rootDir, '03-current-resume.md'), 'hand edit\n');

  await service.adoptFile('resume');
  assert.equal((await load()).currentResume, 'hand edit\n');
  assert.deepEqual((await load()).fileDrift, []);
});

test('a failed file copy does not undo the save', async (context) => {
  const { service, store, rootDir } = setup(context);
  await service.overview();
  const current = await store.getCurrentDocument(USER, 'resume');
  fs.rmSync(path.join(rootDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'profile'), 'a file where the folder was');
  const logged = console.error;
  console.error = () => {};
  context.after(() => { console.error = logged; });
  const result = await service.saveDocument('resume', `${RESUME}Kept.\n`, { baseVersion: current.version });
  assert.equal(result.fileCopy, 'failed');
  assert.equal((await store.getCurrentDocument(USER, 'resume')).content, `${RESUME}Kept.\n`);
});

test('the demo never reads or writes the real files', async (context) => {
  const { service, store, load, rootDir } = setup(context, { demo: true });
  assert.deepEqual((await service.overview()).documents, { profile: null, preferences: null, resume: null, stories: null }, 'real files are not imported');
  await assert.rejects(load(), /Missing candidate profile/);
  const result = await service.saveDocument('resume', 'demo text\n', { baseVersion: null });
  assert.equal(result.fileCopy, 'skipped');
  assert.equal(fileText(rootDir, '03-current-resume.md'), RESUME);
  await assert.rejects(service.adoptFile('resume'), { code: 'file_not_found' });
  assert.ok(await store.getCurrentDocument(USER, 'resume'));
});

test('a new user starts from one CV, which also becomes their profile', async (context) => {
  const { service, store } = setup(context, { files: false });
  await assert.rejects(service.saveDocument('resume', RESUME, { baseVersion: 5 }), { code: 'version_conflict' });
  assert.equal(await store.getCurrentDocument(USER, 'profile'), null);
  await service.saveDocument('resume', RESUME, { baseVersion: null });
  const profile = await store.getCurrentDocument(USER, 'profile');
  assert.equal(profile.content, RESUME);
  assert.equal(profile.source, 'from_resume');
  await service.saveDocument('resume', `${RESUME}Later.\n`, { baseVersion: 1 });
  assert.equal((await store.getCurrentDocument(USER, 'profile')).content, RESUME, 'only the first time');
});

test('a user without documents gets the clear errors', async (context) => {
  const { load, store } = setup(context, { files: false });
  await assert.rejects(load(), /Missing candidate profile/);
  await store.saveDocumentVersion(USER, 'profile', PROFILE, { source: 'editor' });
  await assert.rejects(load(), /Missing candidate preferences/);
});

test('users never see or change each other\'s documents', async (context) => {
  const { store, config, service } = setup(context);
  const raw = new Database(config.jobsDbPath);
  context.after(() => raw.close());
  raw.prepare('INSERT INTO users (id, created_at) VALUES (2, 1)').run();
  await service.overview();
  const other = createProfileService({ store, config: { ...config, demo: true }, userId: 2 });
  assert.equal((await other.overview()).documents.resume, null);
  await other.saveDocument('resume', 'Second user\n', { baseVersion: null });
  assert.equal((await store.getCurrentDocument(USER, 'resume')).content, RESUME);
  assert.equal(await other.getVersion('profile', 2), null);
  await assert.rejects(other.restoreVersion('preferences', 1, { baseVersion: null }), { statusCode: 404 });
  assert.equal(fileText(config.rootDir, '03-current-resume.md'), RESUME);
});
