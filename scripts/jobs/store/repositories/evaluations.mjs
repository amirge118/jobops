import { companyIdentityKey, normalizeCompanyRole } from '../../core.mjs';
import { parseSources, sourceKinds, parseJson, JOB_DECISIONS } from '../shared.mjs';

// The retry source a sighting kind maps back to (the prefix filters match on).
const SIGHTING_RETRY_SOURCES = { ats: 'ATS: retry', whatsapp: 'WhatsApp: retry', linkedin: 'LinkedIn: retry' };

const FIT_DIMENSION_KEYS = ['cvMatch', 'seniority', 'roleScope', 'location', 'sector'];

function mapJobDecision(row) {
  return {
    jobKey: row.job_key,
    decision: row.decision,
    decidedAt: row.decided_at,
    company: row.company,
    title: row.title,
    applyUrl: row.apply_url,
    score: row.score,
    fitLabel: row.fit_label,
    fit: parseJson(row.fit_json, null),
    sourceKinds: parseJson(row.source_kinds_json, []),
    screenPass: row.screen_pass,
    criteriaVersion: row.criteria_version,
    firstSeenAt: row.first_seen_at,
  };
}

export function createEvaluationsRepository({ db, store, identity }) {
  const { findTwinRow, isSettled, markDuplicateRow } = identity;

  return {
    // The failure list on the scan page: active jobs whose last attempt failed.
    async listFailedJobs() {
      return await db.prepare(`
        SELECT job_key, canonical_url, company, title, sources_json, last_error_code, last_error_reason,
               last_attempted_at, first_seen_at
        FROM jobs WHERE archived_at IS NULL AND last_error_code IS NOT NULL
        ORDER BY last_error_code, last_attempted_at DESC
      `).all();
    },

    // excludeErrorCodes lets a caller skip failures classified as not worth
    // retrying (e.g. a site-level anti-bot block) — a job that never got a
    // real error (evaluated_at IS NULL, last_error_code IS NULL) is always
    // included regardless, since that's a brand-new candidate, not a stuck
    // failure.
    async listPendingEvaluation({ limit = 5_000, excludeErrorCodes = [] } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 5_000, 10_000));
      const codes = Array.isArray(excludeErrorCodes) ? excludeErrorCodes.filter(Boolean) : [];
      const excludeClause = codes.length
        ? `AND (last_error_code IS NULL OR last_error_code NOT IN (${codes.map(() => '?').join(', ')}))`
        : '';
      return (await db.prepare(`
        SELECT
          job_key AS jobKey,
          canonical_url AS canonicalUrl,
          apply_url AS url,
          company,
          title,
          sources_json AS sourcesJson,
          (SELECT source_kind FROM job_source_sightings s WHERE s.job_key = jobs.job_key
            ORDER BY s.first_seen_at DESC LIMIT 1) AS sightingKind
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND (evaluated_at IS NULL OR last_error_code IS NOT NULL OR rescore_requested_at IS NOT NULL)
          ${excludeClause}
        ORDER BY first_seen_at ASC
        LIMIT ?
      `).all(...codes, boundedLimit)).map(({ sourcesJson, sightingKind, ...job }) => ({
        ...job,
        // A rejected job keeps no sources_json, so a failed re-check of it
        // falls back to its latest sighting; otherwise no per-source run
        // would ever retry it.
        source: parseSources(sourcesJson)[0] || SIGHTING_RETRY_SOURCES[sightingKind] || 'retry',
      }));
    },

    async needsEvaluation(jobKey, { contentHash, criteriaVersion, activeStatus }) {
      const job = await store.getJob(jobKey);
      if (job?.archived_at) return false;
      if (!job?.evaluated_at) return true;
      return Boolean(job.rescore_requested_at) || job.content_hash !== contentHash ||
        job.criteria_version !== criteriaVersion ||
        (activeStatus && job.active_status !== activeStatus);
    },

    async markEvaluationFailure(jobKey, { code, reason, attemptedAt = Date.now() }) {
      const safeCode = String(code || 'unknown_failure').trim();
      if (!/^[a-z0-9_:-]{1,64}$/i.test(safeCode)) throw new Error('Invalid evaluation failure code');
      const safeReason = String(reason || 'Unknown evaluation failure')
        .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const result = await db.prepare(`
        UPDATE jobs SET
          last_error_code = ?,
          last_error_reason = ?,
          last_attempted_at = ?
        WHERE job_key = ? AND archived_at IS NULL
      `).run(safeCode, safeReason, attemptedAt, jobKey);
      if (result.changes !== 1) throw new Error(`Cannot record evaluation failure for job: ${jobKey}`);
    },

    async saveEvaluation(jobKey, evaluation) {
      const existing = await store.getJob(jobKey);
      if (!existing) throw new Error(`Unknown job: ${jobKey}`);
      const suitable = Boolean(evaluation.suitable);
      await db.prepare(`
        UPDATE jobs SET
          rescore_requested_at = NULL,
          company = @company,
          title = @title,
          company_role_key = @companyRoleKey,
          summary = @summary,
          score = @score,
          fit_label = @fitLabel,
          decision_reason = @decisionReason,
          fit_breakdown_json = @fitBreakdownJson,
          suitable = @suitable,
          apply_url = @applyUrl,
          active_status = @activeStatus,
          content_hash = @contentHash,
          profile_hash = @profileHash,
          criteria_version = @criteriaVersion,
          evaluated_at = @evaluatedAt,
          first_scored_at = CASE WHEN @scoredByModel = 1 THEN COALESCE(first_scored_at, @evaluatedAt) ELSE first_scored_at END,
          first_suitable_at = CASE WHEN @suitable = 1 THEN COALESCE(first_suitable_at, @evaluatedAt) ELSE first_suitable_at END,
          sources_json = @sources,
          last_error_code = NULL,
          last_error_reason = NULL,
          last_attempted_at = @evaluatedAt
        WHERE job_key = @jobKey
      `).run({
        ...evaluation,
        companyRoleKey: normalizeCompanyRole(evaluation.company, evaluation.title),
        company: suitable ? evaluation.company : null,
        title: suitable ? evaluation.title : null,
        summary: suitable ? evaluation.summary : null,
        score: suitable ? evaluation.score : null,
        fitLabel: suitable ? evaluation.fitLabel : null,
        decisionReason: suitable ? evaluation.decisionReason : null,
        fitBreakdownJson: suitable && evaluation.fitBreakdown
          ? JSON.stringify(evaluation.fitBreakdown)
          : null,
        suitable: suitable ? 1 : 0,
        // Only a real model call counts as scoring cost; local filters and
        // dead-link verdicts also land here and must not inflate it.
        scoredByModel: evaluation.scoredByModel === true ? 1 : 0,
        applyUrl: suitable ? evaluation.applyUrl : existing.canonical_url,
        sources: suitable ? existing.sources_json : '[]',
        jobKey,
      });
      if (!suitable) {
        await db.prepare(`
          UPDATE jobs SET
            resume_gap_json = NULL,
            resume_gap_input_hash = NULL,
            resume_gap_analyzed_at = NULL,
            resume_gap_error_code = NULL,
            resume_gap_error_reason = NULL,
            resume_gap_last_attempted_at = NULL
          WHERE job_key = ?
        `).run(jobKey);
        await db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(existing.canonical_url);
        await db.prepare('UPDATE linkedin_postings SET external_canonical_url = NULL WHERE job_key = ?').run(jobKey);
      }

      // Scoring can reveal an identity that matches another job. A twin whose
      // verdict still holds wins; a stale or pending twin yields to this fresh
      // verdict — unless this one is a dead link, which never hides a live twin.
      const key = normalizeCompanyRole(evaluation.company, evaluation.title);
      const twin = key === '::' ? null : await findTwinRow.get(key, jobKey);
      if (twin) {
        const context = { profileHash: evaluation.profileHash, criteriaVersion: evaluation.criteriaVersion };
        const thisIsDead = evaluation.activeStatus && evaluation.activeStatus !== 'active' && evaluation.activeStatus !== 'unknown';
        if (thisIsDead || isSettled(twin, context)) await markDuplicateRow(jobKey, twin.job_key, evaluation.evaluatedAt ?? Date.now());
        else await markDuplicateRow(twin.job_key, jobKey, evaluation.evaluatedAt ?? Date.now());
      }
    },

    // A reliable "what's failing right now" view — independent of any one
    // run, since a stuck failure keeps re-appearing across runs until it's
    // fixed, retried successfully, or archived.
    async getFailureBreakdown() {
      return await db.prepare(`
        SELECT last_error_code AS code, COUNT(*) AS count
        FROM jobs
        WHERE archived_at IS NULL AND last_error_code IS NOT NULL
        GROUP BY last_error_code
        ORDER BY count DESC, last_error_code ASC
      `).all();
    },

    // Bulk version of archiveJob for "clear every failure of this kind" —
    // same field-nulling as a single archive, just scoped by error code
    // instead of by job key. A no-op (never a malformed `IN ()`) on an
    // empty code list.
    async archiveJobsByErrorCode(codes, at = Date.now()) {
      const safeCodes = Array.isArray(codes) ? codes.filter(Boolean) : [];
      if (safeCodes.length === 0) return { archived: 0 };
      const result = await db.prepare(`
        UPDATE jobs SET
          company = NULL,
          title = NULL,
          summary = NULL,
          score = NULL,
          fit_label = NULL,
          decision_reason = NULL,
          fit_breakdown_json = NULL,
          resume_gap_json = NULL,
          resume_gap_input_hash = NULL,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = NULL,
          resume_gap_error_reason = NULL,
          resume_gap_last_attempted_at = NULL,
          suitable = 0,
          active_status = 'archived',
          apply_url = canonical_url,
          sources_json = '[]',
          content_hash = NULL,
          profile_hash = NULL,
          criteria_version = NULL,
          evaluated_at = NULL,
          presented_at = NULL,
          opened_at = NULL,
          last_error_code = NULL,
          last_error_reason = NULL,
          last_attempted_at = NULL,
          link_hint = NULL,
          archived_at = ?
        WHERE archived_at IS NULL AND last_error_code IN (${safeCodes.map(() => '?').join(', ')})
      `).run(at, ...safeCodes);
      return { archived: result.changes };
    },

    // LinkedIn postings that waited in the queue for longer than `olderThanMs`
    // without ever being read are archived unread: the queue is read newest
    // first, so they would never be reached, and a posting that old matters
    // little (2026-10-23: 128 of 181 queued postings were 3+ days old).
    // Same field-clearing as archiveJob; the job key stays for dedup.
    async archiveStaleLinkedInQueue({ olderThanMs, at = Date.now() }) {
      const keys = (await db.prepare(`
        SELECT job_key AS jobKey FROM jobs
        WHERE archived_at IS NULL AND canonical_url LIKE '%linkedin.com/jobs/view/%'
          AND last_error_code IN ('linkedin_deferred', 'linkedin_cooldown', 'linkedin_rate_limited', 'linkedin_blocked')
          AND score IS NULL AND first_seen_at < ?
      `).all(Number(at) - Number(olderThanMs))).map((row) => row.jobKey);
      let archived = 0;
      await db.transaction(async () => { for (const jobKey of keys) if (await store.archiveJob(jobKey, at)) archived += 1; })();
      return { archived };
    },

    async archiveJob(jobKey, at = Date.now()) {
      const result = await db.prepare(`
        UPDATE jobs SET
          company = NULL,
          title = NULL,
          summary = NULL,
          score = NULL,
          fit_label = NULL,
          decision_reason = NULL,
          fit_breakdown_json = NULL,
          resume_gap_json = NULL,
          resume_gap_input_hash = NULL,
          resume_gap_analyzed_at = NULL,
          resume_gap_error_code = NULL,
          resume_gap_error_reason = NULL,
          resume_gap_last_attempted_at = NULL,
          suitable = 0,
          active_status = 'archived',
          apply_url = canonical_url,
          sources_json = '[]',
          content_hash = NULL,
          profile_hash = NULL,
          criteria_version = NULL,
          evaluated_at = NULL,
          presented_at = NULL,
          opened_at = NULL,
          last_error_code = NULL,
          last_error_reason = NULL,
          last_attempted_at = NULL,
          link_hint = NULL,
          archived_at = ?
        WHERE job_key = ? AND archived_at IS NULL
      `).run(at, jobKey);
      return result.changes === 1;
    },

    // Records what the user did with a shown job, then archives it in the
    // same transaction: the decision row keeps only the small snapshot the
    // statistics need (never page text), and archiveJob wipes the rest.
    async decideJob(jobKey, decision, at = Date.now()) {
      if (!JOB_DECISIONS.has(decision)) {
        throw Object.assign(new Error(`Unknown decision: ${decision}`), { statusCode: 400 });
      }
      return await db.transaction(async () => {
        const job = await db.prepare(`
          SELECT * FROM jobs WHERE job_key = ? AND archived_at IS NULL AND suitable = 1
        `).get(jobKey);
        if (!job) return false;
        const breakdown = parseJson(job.fit_breakdown_json, null);
        const fit = breakdown
          ? Object.fromEntries(FIT_DIMENSION_KEYS.filter((key) => breakdown[key] != null).map((key) => [key, Number(breakdown[key])]))
          : null;
        const screenPass = parseJson(job.resume_gap_json, null)?.screenPass?.level ?? null;
        await db.prepare(`
          INSERT OR REPLACE INTO job_decisions (
            job_key, decision, decided_at, company, title, apply_url, score, fit_label,
            fit_json, source_kinds_json, screen_pass, criteria_version, first_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          jobKey, decision, at, job.company, job.title, job.apply_url, job.score, job.fit_label,
          fit ? JSON.stringify(fit) : null,
          JSON.stringify(sourceKinds(parseSources(job.sources_json))),
          screenPass, job.criteria_version, job.first_seen_at,
        );
        const companyKey = decision === 'company_not_interesting' ? companyIdentityKey(job.company) : '';
        if (companyKey) {
          await db.prepare('INSERT OR IGNORE INTO blocked_companies (company_key, name, blocked_at) VALUES (?, ?, ?)')
            .run(companyKey, String(job.company).slice(0, 200), at);
        }
        if (!await store.archiveJob(jobKey, at)) throw new Error(`Cannot archive decided job: ${jobKey}`);
        return true;
      })();
    },

    async listJobDecisions({ since = 0 } = {}) {
      return (await db.prepare('SELECT * FROM job_decisions WHERE decided_at >= ? ORDER BY decided_at DESC')
        .all(Number(since) || 0)).map(mapJobDecision);
    },

    async markPresented(jobKeys, at = Date.now()) {
      const update = db.prepare('UPDATE jobs SET presented_at = ? WHERE job_key = ?');
      await db.transaction(async (keys) => {
        for (const key of keys) await update.run(at, key);
      })(jobKeys);
    },

    async markOpened(jobKeys, at = Date.now()) {
      const update = db.prepare('UPDATE jobs SET opened_at = ? WHERE job_key = ?');
      await db.transaction(async (keys) => {
        for (const key of keys) await update.run(at, key);
      })(jobKeys);
    },

    async listUnpresentedSuitable() {
      return await db.prepare(`
        SELECT
          job_key AS jobKey,
          company,
          title,
          summary,
          score,
          fit_label AS fitLabel,
          decision_reason AS decisionReason,
          apply_url AS applyUrl
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND suitable = 1 AND presented_at IS NULL AND active_status = 'active'
        ORDER BY score DESC, first_seen_at ASC
      `).all();
    },

    async listUnopenedSuitable() {
      return await db.prepare(`
        SELECT job_key AS jobKey, company, title, apply_url AS applyUrl
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND suitable = 1 AND opened_at IS NULL AND active_status = 'active'
        ORDER BY score DESC, first_seen_at ASC
      `).all();
    },
  };
}
