export function createPagesRepository({ db }) {
  return {
    async getFreshPage(canonicalUrl, { now = Date.now(), ttlMs }) {
      const row = await db.prepare('SELECT * FROM job_pages WHERE canonical_url = ?').get(canonicalUrl);
      if (!row || now - row.fetched_at > ttlMs) return null;
      return row;
    },

    async savePage({ canonicalUrl, finalUrl, status, content, contentHash, fetchedAt = Date.now() }) {
      await db.prepare(`
        INSERT INTO job_pages (canonical_url, final_url, status, content, content_hash, fetched_at)
        VALUES (@canonicalUrl, @finalUrl, @status, @content, @contentHash, @fetchedAt)
        ON CONFLICT(canonical_url) DO UPDATE SET
          final_url = excluded.final_url,
          status = excluded.status,
          content = excluded.content,
          content_hash = excluded.content_hash,
          fetched_at = excluded.fetched_at
      `).run({ canonicalUrl, finalUrl, status, content, contentHash, fetchedAt });
    },

    async discardPage(canonicalUrl) {
      await db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(canonicalUrl);
    },
  };
}
