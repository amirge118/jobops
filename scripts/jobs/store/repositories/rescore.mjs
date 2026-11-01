const ACTIVE_SUITABLE = 'archived_at IS NULL AND duplicate_of IS NULL AND evaluated_at IS NOT NULL AND last_error_code IS NULL AND suitable = 1';
const RECENTLY_REJECTED = 'archived_at IS NULL AND duplicate_of IS NULL AND evaluated_at >= ? AND last_error_code IS NULL AND suitable = 0';
const OUTDATED = 'profile_hash IS NOT NULL AND profile_hash <> ? AND rescore_requested_at IS NULL';

export function createRescoreRepository({ db }) {
  return {
    async countOutdatedVerdicts(currentHash, { rejectedSince }) {
      const count = (where, ...params) => db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`).get(...params);
      return {
        active: (await count(`${ACTIVE_SUITABLE} AND ${OUTDATED}`, currentHash)).n,
        rejected: (await count(`${RECENTLY_REJECTED} AND ${OUTDATED}`, rejectedSince, currentHash)).n,
        requested: (await count('rescore_requested_at IS NOT NULL')).n,
      };
    },

    async requestRescore(currentHash, { rejectedSince = null, rejectedLimit, at = Date.now() }) {
      return await db.transaction(async () => {
        const mark = db.prepare(`UPDATE jobs SET rescore_requested_at = ? WHERE ${ACTIVE_SUITABLE} AND ${OUTDATED}`);
        let marked = (await mark.run(at, currentHash)).changes;
        if (rejectedSince != null) {
          marked += (await db.prepare(`
            UPDATE jobs SET rescore_requested_at = ? WHERE job_key IN (
              SELECT job_key FROM jobs WHERE ${RECENTLY_REJECTED} AND ${OUTDATED} ORDER BY evaluated_at DESC LIMIT ?
            )
          `).run(at, rejectedSince, currentHash, rejectedLimit)).changes;
        }
        return marked;
      })();
    },

    async averageScoringTokensPerJob({ since }) {
      const row = await db.prepare(`
        SELECT SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens, SUM(items) AS jobs
        FROM codex_calls WHERE purpose = 'scoring' AND ok = 1 AND created_at >= ?
      `).get(since);
      return row?.jobs ? Math.round(row.tokens / row.jobs) : null;
    },
  };
}
