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

  return {
    async overview() {
      await importMissingFromFiles(sync);
      const documents = {};
      for (const kind of DOCUMENT_KINDS) documents[kind] = await store.getCurrentDocument(userId, kind);
      return {
        identity: parseIdentity(documents.profile?.content ?? ''),
        documents,
        fileDrift: await driftedKinds(sync),
      };
    },

    // A new user starts from one CV, which also becomes their profile until
    // they add facts that do not fit a CV.
    async saveDocument(kind, content, { baseVersion }) {
      validateBaseVersion(baseVersion);
      const saved = await save(kind, content, { baseVersion, source: 'editor' });
      if (saved.status === 'saved' && kind === 'resume' && !await store.getCurrentDocument(userId, 'profile')) {
        await save('profile', content, { baseVersion: null, source: 'from_resume' });
      }
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
