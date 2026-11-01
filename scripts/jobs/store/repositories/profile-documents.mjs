import { createHash } from 'node:crypto';

// Old versions beyond this are dropped; a CV has no use for a longer history.
const VERSIONS_KEPT = 50;

const hashOf = (content) => createHash('sha256').update(content).digest('hex');

function mapDocument(row) {
  return row ? {
    kind: row.kind, version: row.version, content: row.content, contentHash: row.content_hash,
    source: row.source, createdAt: row.created_at,
  } : null;
}

export function createProfileDocumentsRepository({ db, store }) {
  const insertVersion = async (userId, kind, version, content, source, at) => {
    await db.prepare(`
      INSERT INTO profile_documents (user_id, kind, version, content, content_hash, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, kind, version, content, hashOf(content), source, at);
    await db.prepare('DELETE FROM profile_documents WHERE user_id = ? AND kind = ? AND version <= ?')
      .run(userId, kind, version - VERSIONS_KEPT);
  };

  return {
    async getCurrentDocument(userId, kind) {
      return mapDocument(await db.prepare(`
        SELECT * FROM profile_documents WHERE user_id = ? AND kind = ? ORDER BY version DESC LIMIT 1
      `).get(userId, kind));
    },

    async getDocumentVersion(userId, kind, version) {
      return mapDocument(await db.prepare('SELECT * FROM profile_documents WHERE user_id = ? AND kind = ? AND version = ?')
        .get(userId, kind, version));
    },

    async listDocumentVersions(userId, kind) {
      return (await db.prepare(`
        SELECT version, source, created_at, LENGTH(content) AS length FROM profile_documents
        WHERE user_id = ? AND kind = ? ORDER BY version DESC
      `).all(userId, kind)).map((row) => ({
        version: row.version, source: row.source, createdAt: row.created_at, length: row.length,
      }));
    },

    // baseVersion is the version the editor started from: saving over a newer
    // one, from another tab or a skill, is refused rather than silently lost.
    // Pass undefined when there is no editor to protect.
    async saveDocumentVersion(userId, kind, content, { source, baseVersion, at = Date.now() }) {
      return await db.transaction(async () => {
        const current = await store.getCurrentDocument(userId, kind);
        if (baseVersion !== undefined && baseVersion !== (current?.version ?? null)) return { status: 'conflict', document: current };
        if (current?.content === content) return { status: 'unchanged', document: current };
        await insertVersion(userId, kind, (current?.version ?? 0) + 1, content, source, at);
        return { status: 'saved', document: await store.getCurrentDocument(userId, kind) };
      })();
    },

    // Adds only what is missing, all at once, so processes starting together
    // cannot import twice or half-way.
    async importMissingDocuments(userId, documents, { alias = null, at = Date.now() } = {}) {
      return await db.transaction(async () => {
        const imported = [];
        for (const { kind, content } of documents) {
          if (await store.getCurrentDocument(userId, kind)) continue;
          await insertVersion(userId, kind, 1, content, 'import', at);
          imported.push(kind);
        }
        if (alias && imported.length === documents.length) {
          await store.saveScoringHashAlias(userId, alias.canonicalHash, alias.storedHash);
        }
        return imported;
      })();
    },

    async getScoringHashAlias(userId, canonicalHash) {
      return (await db.prepare('SELECT stored_hash FROM scoring_hash_aliases WHERE user_id = ? AND canonical_hash = ?')
        .get(userId, canonicalHash))?.stored_hash ?? null;
    },

    // The hash stored verdicts carried when this user's files were imported.
    async getImportedScoringHash(userId) {
      return (await db.prepare('SELECT stored_hash FROM scoring_hash_aliases WHERE user_id = ? LIMIT 1').get(userId))?.stored_hash ?? null;
    },

    async saveScoringHashAlias(userId, canonicalHash, storedHash) {
      await db.prepare(`
        INSERT INTO scoring_hash_aliases (user_id, canonical_hash, stored_hash) VALUES (?, ?, ?)
        ON CONFLICT(user_id, canonical_hash) DO UPDATE SET stored_hash = excluded.stored_hash
      `).run(userId, canonicalHash, storedHash);
    },

    async getProfileFileExport(userId, kind) {
      return (await db.prepare('SELECT content_hash FROM profile_file_exports WHERE user_id = ? AND kind = ?')
        .get(userId, kind))?.content_hash ?? null;
    },

    async saveProfileFileExport(userId, kind, contentHash) {
      await db.prepare(`
        INSERT INTO profile_file_exports (user_id, kind, content_hash) VALUES (?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET content_hash = excluded.content_hash
      `).run(userId, kind, contentHash);
    },
  };
}
