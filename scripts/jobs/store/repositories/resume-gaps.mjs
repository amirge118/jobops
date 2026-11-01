import { termKey } from '../../gap-insights.mjs';
import { parseJson, GAP_TERM_STATUSES } from '../shared.mjs';

function compactText(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function createResumeGapsRepository({ db, userId }) {
  return {
    async countResumeGapFailures() {
      return await db.prepare(`
        SELECT resume_gap_error_code AS code, COUNT(*) AS count FROM jobs
        WHERE archived_at IS NULL AND resume_gap_error_code IS NOT NULL GROUP BY resume_gap_error_code
      `).all();
    },

    async listResumeGapCandidates({ limit = 500 } = {}) {
      const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 500));
      return await db.prepare(`
        SELECT
          j.job_key AS jobKey,
          j.company,
          j.title,
          j.apply_url AS applyUrl,
          j.content_hash AS contentHash,
          j.profile_hash AS profileHash,
          j.resume_gap_input_hash AS storedResumeGapInputHash,
          j.resume_gap_error_code AS resumeGapErrorCode,
          j.sources_json AS sourcesJson,
          j.evaluated_at AS evaluatedAt,
          p.content
        FROM jobs j
        JOIN job_pages p ON p.canonical_url = j.canonical_url
        WHERE j.archived_at IS NULL AND j.duplicate_of IS NULL
          AND j.evaluated_at IS NOT NULL
          AND j.suitable = 1
          AND j.active_status = 'active'
        ORDER BY j.last_seen_at DESC, j.score DESC
        LIMIT ?
      `).all(boundedLimit);
    },

    async saveResumeGap(jobKey, { inputHash, analysis, analyzedAt = Date.now(), resumeHash = null }) {
      return await db.transaction(async () => {
        const result = await db.prepare(`
          UPDATE jobs SET
            resume_gap_json = ?,
            resume_gap_input_hash = ?,
            resume_gap_analyzed_at = ?,
            resume_gap_error_code = NULL,
            resume_gap_error_reason = NULL,
            resume_gap_last_attempted_at = ?
          WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
        `).run(JSON.stringify(analysis), inputHash, analyzedAt, analyzedAt, jobKey);
        if (result.changes !== 1) throw new Error(`Cannot save resume analysis for job: ${jobKey}`);
        await db.prepare(`
          INSERT OR REPLACE INTO gap_observations (user_id, job_key, company, title, score, resume_hash, analysis_json, observed_at)
          SELECT ?, job_key, company, title, score, ?, ?, ? FROM jobs WHERE job_key = ?
        `).run(userId, resumeHash, JSON.stringify({ items: analysis.items || [], employerPriorities: analysis.employerPriorities || [] }), analyzedAt, jobKey);
      })();
    },

    async listGapObservations() {
      return (await db.prepare(`
        SELECT g.job_key AS jobKey, g.company, g.title, g.score, g.resume_hash AS resumeHash,
          g.analysis_json AS analysisJson, g.observed_at AS observedAt, d.decision
        FROM gap_observations g LEFT JOIN job_decisions d ON d.job_key = g.job_key AND d.user_id = g.user_id
        WHERE g.user_id = ?
        ORDER BY g.observed_at DESC
      `).all(userId)).map(({ analysisJson, ...row }) => ({ ...row, analysis: parseJson(analysisJson, { items: [], employerPriorities: [] }) }));
    },

    async markResumeGapFailure(jobKey, { inputHash, code = 'resume_gap_failed', reason, attemptedAt = Date.now() }) {
      const safeReason = String(reason || 'Resume analysis failed.')
        .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const result = await db.prepare(`
        UPDATE jobs SET
          resume_gap_json = NULL,
          resume_gap_input_hash = ?,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = ?,
          resume_gap_error_reason = ?,
          resume_gap_last_attempted_at = ?
        WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
      `).run(inputHash, String(code).slice(0, 64), safeReason, attemptedAt, jobKey);
      if (result.changes !== 1) throw new Error(`Cannot record resume analysis failure for job: ${jobKey}`);
    },

    // The user's own state per aggregated gap term: working on it, or hidden
    // as noise. Keyed by the same normalization the aggregation groups by.
    async listGapTermStatuses() {
      return await db.prepare('SELECT term_key AS termKey, term, status, updated_at AS updatedAt FROM gap_term_statuses WHERE user_id = ?').all(userId);
    },

    // Map(termKey → covered) for one resume version.
    async listGapTermCoverage(coverageKey) {
      return new Map((await db.prepare('SELECT term_key AS termKey, covered FROM gap_term_coverage WHERE user_id = ? AND coverage_key = ?')
        .all(userId, coverageKey)).map((row) => [row.termKey, row.covered === 1]));
    },

    async saveGapTermCoverage(coverageKey, rows, at = Date.now()) {
      const insert = db.prepare(`
        INSERT INTO gap_term_coverage (user_id, coverage_key, term_key, covered, checked_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, coverage_key, term_key) DO UPDATE SET covered = excluded.covered, checked_at = excluded.checked_at
      `);
      await db.transaction(async () => {
        // Answers for older resumes can never be read again.
        await db.prepare('DELETE FROM gap_term_coverage WHERE user_id = ? AND coverage_key != ?').run(userId, coverageKey);
        for (const row of rows) await insert.run(userId, coverageKey, row.termKey, row.covered ? 1 : 0, at);
      })();
    },

    async setGapTermStatus(term, status, at = Date.now()) {
      const key = termKey(term);
      if (!key) throw Object.assign(new Error('term is required'), { statusCode: 400 });
      if (status == null) {
        await db.prepare('DELETE FROM gap_term_statuses WHERE user_id = ? AND term_key = ?').run(userId, key);
        return null;
      }
      if (!GAP_TERM_STATUSES.has(status)) {
        throw Object.assign(new Error(`Unknown gap term status: ${status}`), { statusCode: 400 });
      }
      await db.prepare(`
        INSERT INTO gap_term_statuses (user_id, term_key, term, status, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, term_key) DO UPDATE SET term = excluded.term, status = excluded.status, updated_at = excluded.updated_at
      `).run(userId, key, compactText(term, 100), status, at);
      return { termKey: key, term: compactText(term, 100), status, updatedAt: at };
    },
  };
}
