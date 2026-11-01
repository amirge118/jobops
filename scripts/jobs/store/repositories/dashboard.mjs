import { resumeGapInputHash } from '../../core.mjs';
import { parseSources, sourceKinds, parseJson } from '../shared.mjs';

export function createDashboardRepository({ db, store }) {
  return {
    async getDashboardStats() {
      const stats = await db.prepare(`
        SELECT
          SUM(CASE WHEN archived_at IS NULL AND duplicate_of IS NULL THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' THEN 1 ELSE 0 END) AS suitable,
          SUM(CASE WHEN archived_at IS NULL AND suitable = 1 AND active_status = 'active' AND opened_at IS NULL THEN 1 ELSE 0 END) AS unopened
        FROM jobs
      `).get();
      return {
        total: Number(stats.total || 0),
        suitable: Number(stats.suitable || 0),
        unopened: Number(stats.unopened || 0),
      };
    },

    async listDashboardJobs({ resumeGapContext = null } = {}) {
      return (await db.prepare(`
        SELECT
          job_key AS jobKey,
          company,
          title,
          summary,
          score,
          fit_label AS fitLabel,
          decision_reason AS decisionReason,
          fit_breakdown_json AS fitBreakdownJson,
          apply_url AS applyUrl,
          suitable,
          active_status AS activeStatus,
          content_hash AS contentHash,
          profile_hash AS profileHash,
          resume_gap_json AS resumeGapJson,
          resume_gap_input_hash AS resumeGapInputHash,
          resume_gap_analyzed_at AS resumeGapAnalyzedAt,
          resume_gap_error_code AS resumeGapErrorCode,
          resume_gap_error_reason AS resumeGapErrorReason,
          last_seen_at AS lastSeenAt,
          opened_at AS openedAt,
          sources_json AS sourcesJson
        FROM jobs
        WHERE archived_at IS NULL AND duplicate_of IS NULL
          AND evaluated_at IS NOT NULL AND suitable = 1 AND active_status = 'active'
        ORDER BY last_seen_at DESC, score DESC
        LIMIT 500
      `).all()).map((job) => {
        const expectedHash = resumeGapContext?.resumeAvailable
          ? resumeGapInputHash({
            contentHash: job.contentHash,
            profileHash: job.profileHash,
            resumeHash: resumeGapContext.resumeHash,
            analysisVersion: resumeGapContext.analysisVersion,
          })
          : null;
        const isCurrent = Boolean(expectedHash && job.resumeGapInputHash === expectedHash);
        const analysis = isCurrent ? parseJson(job.resumeGapJson, null) : null;
        const resumeGap = !resumeGapContext?.resumeAvailable
          ? { status: 'unavailable', items: [] }
          : analysis && Array.isArray(analysis.items)
            ? {
              status: 'ready',
              items: analysis.items,
              employerPriorities: Array.isArray(analysis.employerPriorities) ? analysis.employerPriorities : [],
              screenPass: analysis.screenPass ?? null,
              analyzedAt: job.resumeGapAnalyzedAt,
            }
            : isCurrent && job.resumeGapErrorCode
              ? {
                status: 'failed',
                items: [],
                code: job.resumeGapErrorCode,
                reason: job.resumeGapErrorReason || 'ניתוח קורות החיים נכשל.',
              }
              : { status: 'pending', items: [] };
        const hidden = new Set([
          'fitBreakdownJson', 'contentHash', 'profileHash', 'resumeGapJson',
          'resumeGapInputHash', 'resumeGapAnalyzedAt', 'resumeGapErrorCode', 'resumeGapErrorReason',
          'sourcesJson',
        ]);
        return {
          ...Object.fromEntries(Object.entries(job).filter(([key]) => !hidden.has(key))),
          sourceKinds: sourceKinds(parseSources(job.sourcesJson)),
          fitBreakdown: parseJson(job.fitBreakdownJson, null),
          resumeGap,
          suitable: Boolean(job.suitable),
        };
      });
    },

    async getDashboardSnapshot() {
      return {
        stats: await store.getDashboardStats(),
        jobs: await store.listDashboardJobs(),
        lastRun: await store.getLastRun(),
      };
    },
  };
}
