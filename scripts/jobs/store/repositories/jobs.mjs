import { createHash } from 'node:crypto';
import { canonicalizeJobUrl, normalizeCompanyRole } from '../../core.mjs';
import { parseSources } from '../shared.mjs';

function stableJobKey(canonicalUrl) {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
}

export function createJobsRepository({ db, identity }) {
  const { noteSourceSighting, findByIdentity, getJobRow, findTwinRow, representativeOf, isSettled, markDuplicateRow, planIdentityDedup } = identity;

  return {
    // Same URL, or same company + role from any source, is the same job.
    // Kept only until the job is first decided; an existing hint (e.g. from the
    // URL slug) is never replaced by a weaker one from a later sighting.
    async setLinkHint(jobKey, hint) {
      return await db.transaction(async () => {
        if (!hint) return false;
        const rank = { slug: 3, bold: 2, text: 1 };
        const current = await db.prepare('SELECT link_hint, evaluated_at FROM jobs WHERE job_key = ?').get(jobKey);
        if (!current || current.evaluated_at) return false;
        const previous = (() => { try { return JSON.parse(current.link_hint || 'null'); } catch { return null; } })();
        if (previous && (rank[previous.source] || 0) >= (rank[hint.source] || 0)) return false;
        await db.prepare('UPDATE jobs SET link_hint = ? WHERE job_key = ?').run(JSON.stringify(hint).slice(0, 400), jobKey);
        return true;
      })();
    },

    async recordSighting({ url, company = '', title = '', source, seenAt = Date.now() }) {
      return await db.transaction(async () => {
        const canonicalUrl = canonicalizeJobUrl(url);
        if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);
        const companyRoleKey = normalizeCompanyRole(company, title);
        const existing = await representativeOf(await findByIdentity.get({ canonicalUrl, companyRoleKey }));

        if (existing) {
          if (existing.archived_at || (existing.evaluated_at && !existing.suitable)) {
            await db.prepare('UPDATE jobs SET last_seen_at = ? WHERE job_key = ?').run(seenAt, existing.job_key);
            await noteSourceSighting(existing.job_key, source, company, seenAt);
            return { jobKey: existing.job_key, canonicalUrl: existing.canonical_url, isNew: false };
          }
          const sources = new Set(parseSources(existing.sources_json));
          if (source) sources.add(source);
          await db.prepare(`
            UPDATE jobs
            SET last_seen_at = @seenAt,
                apply_url = CASE WHEN canonical_url = @canonicalUrl THEN @url ELSE apply_url END,
                sources_json = @sources
            WHERE job_key = @jobKey
          `).run({ seenAt, canonicalUrl, url, sources: JSON.stringify([...sources]), jobKey: existing.job_key });
          await noteSourceSighting(existing.job_key, source, company, seenAt);
          return { jobKey: existing.job_key, canonicalUrl: existing.canonical_url, isNew: false };
        }

        const jobKey = stableJobKey(canonicalUrl);
        await db.prepare(`
          INSERT INTO jobs (
            job_key, canonical_url, apply_url, company_role_key, company, title,
            sources_json, first_seen_at, last_seen_at
          ) VALUES (
            @jobKey, @canonicalUrl, @url, @companyRoleKey, @company, @title,
            @sources, @seenAt, @seenAt
          )
        `).run({
          jobKey,
          canonicalUrl,
          url: canonicalUrl.startsWith('https://www.linkedin.com/jobs/view/') ? canonicalUrl : url,
          companyRoleKey,
          company,
          title,
          sources: JSON.stringify(source ? [source] : []),
          seenAt,
        });
        await noteSourceSighting(jobKey, source, company, seenAt);
        return { jobKey, canonicalUrl, isNew: true };
      })();
    },

    // ---- Codex usage and quota ------------------------------------------

    async isKnownJobUrl(canonicalUrl) {
      return Boolean(await db.prepare('SELECT 1 FROM jobs WHERE canonical_url = ?').get(String(canonicalUrl)));
    },

    // Called once a job's real company and title are known (after the page
    // fetch, before scoring). A twin that is already decided, or already
    // queued in this run, makes this job a duplicate so it is never scored.
    // Otherwise the identity is stored so later sightings match it directly.
    async claimJobIdentity(jobKey, { company, title, profileHash = null, criteriaVersion = null, at = Date.now() }) {
      const job = await getJobRow.get(String(jobKey));
      if (!job || job.duplicate_of) return { duplicateOf: job?.duplicate_of ?? null };
      const key = normalizeCompanyRole(company, title);
      if (key === '::') return { duplicateOf: null };
      const twin = await findTwinRow.get(key, job.job_key);
      const twinIsQueued = twin && !twin.evaluated_at && !twin.last_error_code;
      if (twin && (twinIsQueued || isSettled(twin, { profileHash, criteriaVersion }))) {
        return { duplicateOf: await markDuplicateRow(job.job_key, twin.job_key, at) };
      }
      await db.prepare(`
        UPDATE jobs SET company_role_key = ?, company = COALESCE(NULLIF(company, ''), ?), title = COALESCE(NULLIF(title, ''), ?)
        WHERE job_key = ?
      `).run(key, String(company), String(title), job.job_key);
      return { duplicateOf: null };
    },

    // Exact evidence (e.g. a LinkedIn posting whose apply URL is a known job).
    async markDuplicate(duplicateKey, representativeKey, at = Date.now()) {
      return await markDuplicateRow(String(duplicateKey), String(representativeKey), at);
    },

    async planIdentityDedup() {
      return await planIdentityDedup();
    },

    // One-off cleanup of rows stored before cross-source dedup existed.
    async applyIdentityDedup(at = Date.now()) {
      const { rekeys, groups } = await planIdentityDedup();
      await db.transaction(async () => {
        const rekey = db.prepare('UPDATE jobs SET company_role_key = ? WHERE job_key = ?');
        for (const { jobKey, to } of rekeys) await rekey.run(to, jobKey);
        for (const { representative, duplicates } of groups) {
          for (const duplicate of duplicates) await markDuplicateRow(duplicate.job_key, representative.job_key, at);
        }
      })();
      return { rekeyed: rekeys.length, groups: groups.length, duplicates: groups.reduce((sum, group) => sum + group.duplicates.length, 0) };
    },

    async getJob(jobKey) {
      return await db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(jobKey) ?? null;
    },

    async countJobs() {
      return (await db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).count;
    },

    async markDuplicateUrl(canonicalUrl, representativeKey, at = Date.now()) {
      const row = await db.prepare('SELECT job_key FROM jobs WHERE canonical_url = ?').get(String(canonicalUrl));
      return row ? await markDuplicateRow(row.job_key, String(representativeKey), at) : null;
    },

    async listSightingTimes() {
      return await db.prepare('SELECT job_key AS jobKey, source_kind AS sourceKind, first_seen_at AS firstSeenAt FROM job_source_sightings').all();
    },
  };
}
