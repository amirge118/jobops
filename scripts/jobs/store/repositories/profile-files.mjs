// Older uploads beyond this are dropped; their text stays in the document's versions.
const FILES_KEPT = 5;

function mapMeta(row) {
  return row ? {
    fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes,
    textHash: row.text_hash, identity: JSON.parse(row.identity), createdAt: row.created_at,
  } : null;
}

export function createProfileFilesRepository({ db }) {
  return {
    async saveProfileFile(userId, { fileName, mimeType, sha256, sizeBytes, content, textHash, identity = {}, at = Date.now() }) {
      await db.prepare(`
        INSERT INTO profile_files (user_id, file_name, mime_type, sha256, size_bytes, content, text_hash, identity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, fileName, mimeType, sha256, sizeBytes, content, textHash, JSON.stringify(identity), at);
      await db.prepare(`
        DELETE FROM profile_files WHERE user_id = ? AND id NOT IN (
          SELECT id FROM profile_files WHERE user_id = ? ORDER BY id DESC LIMIT ?
        )
      `).run(userId, userId, FILES_KEPT);
    },

    async getCurrentProfileFileMeta(userId) {
      return mapMeta(await db.prepare(`
        SELECT file_name, mime_type, size_bytes, text_hash, identity, created_at
        FROM profile_files WHERE user_id = ? ORDER BY id DESC LIMIT 1
      `).get(userId));
    },

    async getCurrentProfileFile(userId) {
      const row = await db.prepare('SELECT * FROM profile_files WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
      return row ? { ...mapMeta(row), content: row.content } : null;
    },

    async getCvInsight(userId, kind, resumeHash, version) {
      const row = await db.prepare('SELECT result FROM cv_insights WHERE user_id = ? AND kind = ? AND resume_hash = ? AND version = ?')
        .get(userId, kind, resumeHash, version);
      return row ? JSON.parse(row.result) : null;
    },

    async saveCvInsight(userId, kind, resumeHash, version, result, at = Date.now()) {
      await db.prepare(`
        INSERT INTO cv_insights (user_id, kind, resume_hash, version, result, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind, resume_hash, version) DO UPDATE SET result = excluded.result, created_at = excluded.created_at
      `).run(userId, kind, resumeHash, version, JSON.stringify(result), at);
    },
  };
}
