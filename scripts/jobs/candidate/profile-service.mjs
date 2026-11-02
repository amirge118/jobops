import { CV_ANALYSIS_VERSION, CV_FACTS_VERSION, openFacts, profileWithFacts, quoteIsInText } from './cv-insights.mjs';
import { DOCUMENT_KINDS, driftedKinds, exportDocument, importMissingFromFiles, markFileExported, readDocumentFile } from './file-sync.mjs';
import { applyIdentity, parseIdentity, validateIdentityFields } from './identity-section.mjs';

const MAX_DOCUMENT_CHARS = 200_000;

function failure(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function validateContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw failure(400, 'invalid_document', 'יש למלא את המסמך לפני שמירה');
  if (content.length > MAX_DOCUMENT_CHARS) throw failure(413, 'document_too_large', 'המסמך ארוך מדי');
  if (content.includes('\u0000')) throw failure(400, 'invalid_document', 'המסמך מכיל תווים לא תקינים');
}

function validateBaseVersion(baseVersion) {
  if (baseVersion !== null && !Number.isInteger(baseVersion)) throw failure(400, 'invalid_version', 'גרסת המסמך אינה תקינה');
}

// Everything a person can do to their own documents. A saved document always
// wins over its file copy: a failed copy is reported, it does not undo the save.
export function createProfileService({ store, config, userId }) {
  const sync = { store, config, userId };

  async function save(kind, content, { baseVersion, source }) {
    validateContent(content);
    // A save must build on what is in the files, not start history without it.
    await importMissingFromFiles(sync);
    const result = await store.saveDocumentVersion(userId, kind, content, { source, baseVersion });
    if (result.status === 'conflict') throw failure(409, 'version_conflict', 'המסמך השתנה בינתיים. טען מחדש את העמוד לפני השמירה.');
    const fileCopy = result.status === 'saved' ? await exportDocument(sync, result.document) : 'unchanged';
    return { ...result, fileCopy };
  }

  async function saveFirstProfile(saved, content) {
    if (saved.status === 'saved' && !await store.getCurrentDocument(userId, 'profile')) {
      await save('profile', content, { baseVersion: null, source: 'from_resume' });
    }
  }

  async function fileMeta(resume) {
    const meta = await store.getCurrentProfileFileMeta(userId);
    if (!meta) return null;
    const { textHash, identity, ...shown } = meta;
    return { ...shown, textEdited: textHash !== resume?.contentHash };
  }

  async function currentFacts(resume) {
    return await store.getCvInsight(userId, 'facts', resume.contentHash, CV_FACTS_VERSION);
  }

  async function factsContext() {
    await importMissingFromFiles(sync);
    const resume = await store.getCurrentDocument(userId, 'resume');
    if (!resume) throw failure(409, 'no_resume', 'עדיין אין קורות חיים');
    const profile = await store.getCurrentDocument(userId, 'profile');
    const meta = await store.getCurrentProfileFileMeta(userId);
    const fileIdentity = meta?.textHash === resume.contentHash ? meta.identity : {};
    return { resume, profile, open: openFacts(await currentFacts(resume), profile?.content ?? '', fileIdentity, resume.content) };
  }

  return {
    async overview() {
      await importMissingFromFiles(sync);
      const documents = {};
      for (const kind of DOCUMENT_KINDS) documents[kind] = await store.getCurrentDocument(userId, kind);
      return {
        identity: parseIdentity(documents.profile?.content ?? ''),
        documents,
        fileDrift: await driftedKinds(sync),
        resumeFile: await fileMeta(documents.resume),
      };
    },

    // Refuses before the slow reading and organizing, not only at the end.
    async assertResumeVersion(baseVersion) {
      validateBaseVersion(baseVersion);
      await importMissingFromFiles(sync);
      const current = await store.getCurrentDocument(userId, 'resume');
      if (baseVersion !== (current?.version ?? null)) throw failure(409, 'version_conflict', 'המסמך השתנה בינתיים. טען מחדש את העמוד לפני השמירה.');
    },

    // Saved at once: the CV does not affect scores, and every version can be
    // restored. Facts reach the profile only through approveFacts.
    async saveResumeFile(file, draft, { baseVersion }) {
      validateBaseVersion(baseVersion);
      const saved = await save('resume', draft.markdown, { baseVersion, source: 'upload' });
      await saveFirstProfile(saved, draft.markdown);
      await store.saveProfileFile(userId, { ...file, textHash: saved.document.contentHash, identity: draft.identity ?? {} });
      return { document: saved.document, fileCopy: saved.fileCopy, warnings: draft.warnings ?? [], resumeFile: await fileMeta(saved.document) };
    },

    getResumeFile: () => store.getCurrentProfileFile(userId),

    async insights() {
      await importMissingFromFiles(sync);
      if (!await store.getCurrentDocument(userId, 'resume')) return { analysis: null, facts: [], profileVersion: null };
      const { resume, profile, open } = await factsContext();
      return {
        analysis: await store.getCvInsight(userId, 'analysis', resume.contentHash, CV_ANALYSIS_VERSION),
        facts: open,
        profileVersion: profile?.version ?? null,
      };
    },

    // Asks the AI only for what is not stored for this exact CV text. A part
    // that fails is named, and what did succeed is kept.
    async generateInsights(cvInsights) {
      await importMissingFromFiles(sync);
      const resume = await store.getCurrentDocument(userId, 'resume');
      if (!resume) throw failure(409, 'no_resume', 'עדיין אין קורות חיים להסביר');
      const profile = await store.getCurrentDocument(userId, 'profile');
      const failed = [];
      const run = async (kind, version, generate) => {
        if (await store.getCvInsight(userId, kind, resume.contentHash, version)) return;
        try {
          const result = await generate();
          if (result) await store.saveCvInsight(userId, kind, resume.contentHash, version, result);
          else failed.push(kind);
        } catch (error) {
          console.error(`CV ${kind} failed: ${String(error?.message || error).slice(0, 200)}`);
          failed.push(kind);
        }
      };
      await Promise.all([
        run('analysis', CV_ANALYSIS_VERSION, () => cvInsights.analyze(resume.content)),
        // A profile that is the CV itself, or none yet, has nothing to compare.
        profile && profile.content !== resume.content
          ? run('facts', CV_FACTS_VERSION, () => cvInsights.compare(resume.content, profile.content))
          : null,
      ]);
      return { failed };
    },

    // Ids, not text: what enters the profile is what the server itself holds and
    // finds in the current CV, whatever the request says.
    async approveFacts(ids, { baseVersion }) {
      validateBaseVersion(baseVersion);
      if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string')) throw failure(400, 'invalid_facts', 'לא נבחרו עובדות');
      const { resume, profile, open } = await factsContext();
      const chosen = open.filter((item) => ids.includes(item.id) && item.kind !== 'conflict' && quoteIsInText(item.quote, resume.content));
      if (chosen.length !== ids.length) throw failure(409, 'facts_changed', 'העובדות השתנו בינתיים. טען מחדש את העמוד.');
      return await save('profile', profileWithFacts(profile?.content ?? '', chosen), { baseVersion, source: 'from_resume' });
    },

    async dismissFacts(ids) {
      if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string')) throw failure(400, 'invalid_facts', 'לא נבחרו עובדות');
      const { resume, open } = await factsContext();
      const known = new Set(open.map((item) => item.id));
      const facts = await currentFacts(resume) ?? { items: [], dismissed: [] };
      await store.saveCvInsight(userId, 'facts', resume.contentHash, CV_FACTS_VERSION, {
        ...facts, dismissed: [...new Set([...(facts.dismissed ?? []), ...ids.filter((id) => known.has(id))])],
      });
    },

    // A new user starts from one CV, which also becomes their profile until
    // they add facts that do not fit a CV.
    async saveDocument(kind, content, { baseVersion }) {
      validateBaseVersion(baseVersion);
      const saved = await save(kind, content, { baseVersion, source: 'editor' });
      if (kind === 'resume') await saveFirstProfile(saved, content);
      return saved;
    },

    async saveIdentity(fields, { baseVersion }) {
      validateBaseVersion(baseVersion);
      try {
        validateIdentityFields(fields);
      } catch (error) {
        throw failure(400, 'invalid_identity', error.message);
      }
      await importMissingFromFiles(sync);
      const current = await store.getCurrentDocument(userId, 'profile');
      return await save('profile', applyIdentity(current?.content ?? '', fields), { baseVersion, source: 'identity' });
    },

    async restoreVersion(kind, version, { baseVersion }) {
      validateBaseVersion(baseVersion);
      const target = await store.getDocumentVersion(userId, kind, version);
      if (!target) throw failure(404, 'version_not_found', 'הגרסה הזו כבר לא קיימת');
      return await save(kind, target.content, { baseVersion, source: 'restore' });
    },

    // Takes a hand-edited file in, after which it counts as our copy again.
    async adoptFile(kind) {
      const content = readDocumentFile(config, kind);
      if (content === null) throw failure(404, 'file_not_found', 'לא נמצא קובץ לקליטה');
      validateContent(content);
      const result = await store.saveDocumentVersion(userId, kind, content, { source: 'file' });
      await markFileExported(sync, kind, content);
      return result;
    },

    listVersions: (kind) => store.listDocumentVersions(userId, kind),
    getVersion: (kind, version) => store.getDocumentVersion(userId, kind, version),
  };
}
