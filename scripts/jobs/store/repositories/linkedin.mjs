import { canonicalizeJobUrl } from '../../core.mjs';
import { linkedinQueryHash } from '../../linkedin-window.mjs';
import { parseJson, serializeAuditDetails } from '../shared.mjs';

const LINKEDIN_KEYWORDS_PATTERN = /^[\p{L}\p{N} "'()+#.&/,-]+$/u;

export function normalizeLinkedInSearch(input = {}) {
  const text = (value, max) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
  const keywords = text(input.keywords, 200);
  const label = text(input.label, 80) || keywords.slice(0, 80);
  const location = text(input.location, 120) || null;
  const geoId = text(input.geoId ?? input.geo_id, 20) || null;
  const key = text(input.key ?? input.search_key, 64) || null;
  if (!keywords || !LINKEDIN_KEYWORDS_PATTERN.test(keywords)) {
    throw Object.assign(new Error('LinkedIn keywords are required and may contain only letters, digits, spaces, quotes and basic punctuation'), { statusCode: 400 });
  }
  if (location && !LINKEDIN_KEYWORDS_PATTERN.test(location)) {
    throw Object.assign(new Error('LinkedIn location contains unsupported characters'), { statusCode: 400 });
  }
  if (geoId && !/^\d{1,20}$/.test(geoId)) throw Object.assign(new Error('LinkedIn geoId must be numeric'), { statusCode: 400 });
  if (!location && !geoId) throw Object.assign(new Error('A LinkedIn search needs a location or geoId'), { statusCode: 400 });
  if (key && !/^[a-z0-9_-]+$/i.test(key)) throw Object.assign(new Error('LinkedIn search key is invalid'), { statusCode: 400 });
  return { key, label, keywords, location, geoId, enabled: input.enabled !== false && input.enabled !== 0 };
}

function linkedinJobIdFromCanonical(canonical) {
  return canonical.match(/^https:\/\/www\.linkedin\.com\/jobs\/view\/(\d+)$/)?.[1] ?? null;
}

function mapLinkedInSearch(row) {
  return {
    id: row.id,
    key: row.search_key,
    label: row.label,
    keywords: row.keywords,
    location: row.location,
    geoId: row.geo_id,
    enabled: Boolean(row.enabled),
    origin: row.origin,
    queryHash: row.query_hash,
    coveredUntil: row.covered_until ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    lastStatus: row.last_status ?? null,
    lastReason: row.last_reason ?? null,
    lastSummary: parseJson(row.last_summary_json, null),
    gaps: parseJson(row.gaps_json, []),
  };
}

export function createLinkedinRepository({ db, store }) {
  return {
    async listLinkedInPostingUrls(limit) {
      return (await db.prepare(`
        SELECT canonical_url AS url FROM jobs
        WHERE archived_at IS NULL AND canonical_url LIKE '%linkedin.com/jobs/view/%'
        ORDER BY (last_error_code = 'linkedin_deferred') DESC, first_seen_at DESC LIMIT ?
      `).all(limit)).map((row) => row.url);
    },

    async getLinkedInBlock({ now = Date.now() } = {}) {
      const state = await db.prepare('SELECT blocked_reason AS reason, blocked_at AS at, blocked_until AS until FROM linkedin_state WHERE id = 1').get();
      return state?.until > now ? { reason: state.reason, since: new Date(state.at).toISOString() } : null;
    },

    // config/jobs.yml is the only source of truth for LinkedIn searches.
    // Each search is matched by its key; a changed query gets a new query
    // hash (and so a fresh coverage history), and a search removed from the
    // config is disabled rather than deleted, keeping its history.
    async syncLinkedInSearches(configured = [], at = Date.now()) {
      const searches = configured.map(normalizeLinkedInSearch);
      const keys = searches.map((search) => search.key);
      if (keys.some((key) => !key)) throw new Error('Every LinkedIn search in config/jobs.yml needs a key');
      if (new Set(keys).size !== keys.length) throw new Error('LinkedIn search keys in config/jobs.yml must be unique');
      const upsert = db.prepare(`
        INSERT INTO linkedin_searches (search_key, label, keywords, location, geo_id, enabled, origin, query_hash, created_at, updated_at)
        VALUES (@key, @label, @keywords, @location, @geoId, @enabled, 'config', @queryHash, @at, @at)
        ON CONFLICT(search_key) DO UPDATE SET
          label = excluded.label, keywords = excluded.keywords, location = excluded.location, geo_id = excluded.geo_id,
          enabled = excluded.enabled, origin = 'config', query_hash = excluded.query_hash,
          updated_at = CASE WHEN linkedin_searches.query_hash = excluded.query_hash AND linkedin_searches.label = excluded.label
            AND linkedin_searches.enabled = excluded.enabled THEN linkedin_searches.updated_at ELSE excluded.updated_at END
      `);
      const apply = db.transaction(async () => {
        for (const search of searches) {
          await upsert.run({ ...search, enabled: search.enabled ? 1 : 0, queryHash: linkedinQueryHash(search), at });
        }
        const placeholders = keys.map(() => '?').join(', ');
        await db.prepare(`UPDATE linkedin_searches SET enabled = 0, updated_at = ? WHERE enabled = 1${keys.length ? ` AND search_key NOT IN (${placeholders})` : ''}`)
          .run(at, ...keys);
      });
      await apply();
      return await store.listLinkedInSearches();
    },

    async listLinkedInSearches() {
      return (await db.prepare(`
        SELECT s.*, p.covered_until, p.last_success_at, p.last_attempt_at, p.last_status, p.last_reason,
               p.last_summary_json, p.gaps_json
        FROM linkedin_searches s
        LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.query_hash = s.query_hash
        ORDER BY s.id
      `).all()).map(mapLinkedInSearch);
    },

    async getLinkedInSearch(id) {
      const row = await db.prepare(`
        SELECT s.*, p.covered_until, p.last_success_at, p.last_attempt_at, p.last_status, p.last_reason,
               p.last_summary_json, p.gaps_json
        FROM linkedin_searches s
        LEFT JOIN linkedin_search_progress p ON p.search_id = s.id AND p.query_hash = s.query_hash
        WHERE s.id = ?
      `).get(Number(id));
      return row ? mapLinkedInSearch(row) : null;
    },

    // Records one attempt. coveredUntil is only passed when the collection was
    // complete and saved; otherwise the stored coverage is left as it was.
    async recordLinkedInSearchAttempt({ searchId, queryHash, status, reason = null, summary = null, coveredUntil = null, gap = null, attemptedAt = Date.now() }) {
      return await db.transaction(async () => {
        const previous = await db.prepare('SELECT covered_until, gaps_json FROM linkedin_search_progress WHERE search_id = ? AND query_hash = ?')
          .get(Number(searchId), String(queryHash));
        const gaps = parseJson(previous?.gaps_json, []);
        if (gap) gaps.push(gap);
        const succeeded = coveredUntil != null;
        await db.prepare(`
          INSERT INTO linkedin_search_progress (
            search_id, query_hash, covered_until, last_success_at, last_attempt_at, last_status, last_reason, last_summary_json, gaps_json, failed_streak
          ) VALUES (@searchId, @queryHash, @coveredUntil, @successAt, @attemptedAt, @status, @reason, @summary, @gaps, CASE WHEN @status = 'failed' THEN 1 ELSE 0 END)
          ON CONFLICT(search_id, query_hash) DO UPDATE SET
            covered_until = COALESCE(excluded.covered_until, covered_until),
            last_success_at = COALESCE(excluded.last_success_at, last_success_at),
            last_attempt_at = excluded.last_attempt_at,
            last_status = excluded.last_status,
            last_reason = excluded.last_reason,
            last_summary_json = excluded.last_summary_json,
            gaps_json = excluded.gaps_json,
            failed_streak = CASE WHEN excluded.last_status = 'failed' THEN failed_streak + 1 ELSE 0 END
        `).run({
          searchId: Number(searchId),
          queryHash: String(queryHash),
          coveredUntil: succeeded ? Number(coveredUntil) : null,
          successAt: succeeded ? attemptedAt : null,
          attemptedAt,
          status: String(status).slice(0, 32),
          reason: reason == null ? null : String(reason).slice(0, 64),
          summary: summary ? serializeAuditDetails(summary) : null,
          gaps: gaps.length ? JSON.stringify(gaps.slice(-5)) : null,
        });
      })();
    },

    // postedAgeMs is the card's "N hours ago" lower bound; the first
    // sighting's estimate is kept, since later labels only get coarser.
    async recordLinkedInPosting({ linkedinId, jobKey, listedAt = null, postedAgeMs = null, seenAt = Date.now() }) {
      const postedAt = Number.isFinite(postedAgeMs) ? seenAt - postedAgeMs : null;
      await db.prepare(`
        INSERT INTO linkedin_postings (linkedin_id, job_key, listed_at, posted_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(linkedin_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, job_key = excluded.job_key,
          posted_at = COALESCE(linkedin_postings.posted_at, excluded.posted_at)
      `).run(String(linkedinId), String(jobKey), listedAt, postedAt, seenAt, seenAt);
    },

    async listLinkedInPostingTimes({ since = 0 } = {}) {
      return await db.prepare(`
        SELECT posted_at AS postedAt, first_seen_at AS firstSeenAt FROM linkedin_postings
        WHERE posted_at IS NOT NULL AND first_seen_at >= ?
      `).all(Number(since) || 0);
    },

    async linkedinPostedAt(linkedinId) {
      return (await db.prepare('SELECT posted_at FROM linkedin_postings WHERE linkedin_id = ?').get(String(linkedinId)))?.posted_at ?? null;
    },

    // An external apply URL is exact evidence: when it names a job already
    // known from another source, that job is returned so callers can link.
    async recordLinkedInExternalUrl(linkedinId, externalUrl) {
      return await db.transaction(async () => {
        const canonical = canonicalizeJobUrl(externalUrl);
        if (!canonical || linkedinJobIdFromCanonical(canonical)) return null;
        await db.prepare('UPDATE linkedin_postings SET external_canonical_url = ? WHERE linkedin_id = ?').run(canonical, String(linkedinId));
        return (await db.prepare('SELECT job_key FROM jobs WHERE canonical_url = ?').get(canonical))?.job_key ?? null;
      })();
    },

    // ---- LinkedIn cooldown -------------------------------------------------

    async noteLinkedInBlock(reason, { at = Date.now(), cooldownMs = 60 * 60 * 1000, detail = null } = {}) {
      await db.prepare(`
        INSERT INTO linkedin_state (id, blocked_until, blocked_reason, blocked_at, last_activity_at)
        VALUES (1, @until, @reason, @at, @at)
        ON CONFLICT(id) DO UPDATE SET
          blocked_until = MAX(COALESCE(blocked_until, 0), @until),
          blocked_reason = @reason, blocked_at = @at,
          last_activity_at = MAX(COALESCE(last_activity_at, 0), @at)
      `).run({ until: Number(at) + Number(cooldownMs), reason: String(reason).slice(0, 32), at: Number(at) });
      // linkedin_state keeps only the latest block; this row keeps the history
      // (when, and after how many requests). It is not a request: the hourly
      // cap does not count it.
      await db.prepare('INSERT INTO linkedin_requests (at, kind, detail) VALUES (?, ?, ?)')
        .run(Number(at), `refused:${String(reason).slice(0, 24)}`, detail ? JSON.stringify(detail).slice(0, 300) : null);
    },

    // A refusal the run recovered from (one retry after Retry-After): history
    // only — no cooldown, and the hourly cap does not count it.
    async recordLinkedInRefusal({ reason, detail = null, at = Date.now() } = {}) {
      await db.prepare('INSERT INTO linkedin_requests (at, kind, detail) VALUES (?, ?, ?)')
        .run(Number(at), `refused:${String(reason).slice(0, 24)}`, detail ? JSON.stringify(detail).slice(0, 300) : null);
    },

    async recordLinkedInRequest({ kind, at = Date.now() } = {}) {
      await db.prepare('INSERT INTO linkedin_requests (at, kind) VALUES (?, ?)').run(Number(at), String(kind || 'unknown'));
      await db.prepare('DELETE FROM linkedin_requests WHERE at < ?').run(Number(at) - 14 * 24 * 60 * 60 * 1000);
    },

    async countLinkedInRequests({ since, kind = null }) {
      if (kind) return (await db.prepare('SELECT COUNT(*) AS count FROM linkedin_requests WHERE at >= ? AND kind = ?').get(Number(since), String(kind))).count;
      return (await db.prepare("SELECT COUNT(*) AS count FROM linkedin_requests WHERE at >= ? AND kind NOT LIKE 'refused:%'").get(Number(since))).count;
    },

    async noteLinkedInActivity(at = Date.now()) {
      await db.prepare(`
        INSERT INTO linkedin_state (id, last_activity_at) VALUES (1, @at)
        ON CONFLICT(id) DO UPDATE SET last_activity_at = MAX(COALESCE(last_activity_at, 0), @at)
      `).run({ at: Number(at) });
    },

    // A block stops every LinkedIn request; recent activity (another run's
    // searches or page reads) only spaces out page reads, so frequent
    // WhatsApp runs can never starve the scheduled LinkedIn scan.
    async getLinkedInCooldown({ now = Date.now(), afterActivityMs = 15 * 60 * 1000 } = {}) {
      const row = await db.prepare('SELECT * FROM linkedin_state WHERE id = 1').get();
      const block = row?.blocked_until > now ? { until: row.blocked_until, reason: row.blocked_reason || 'blocked' } : null;
      const activityUntil = row?.last_activity_at ? row.last_activity_at + Number(afterActivityMs) : 0;
      const reads = block || (activityUntil > now ? { until: activityUntil, reason: 'recent_activity' } : null);
      return { scans: block, reads };
    },

    async getLinkedInPosting(linkedinId) {
      return await db.prepare('SELECT * FROM linkedin_postings WHERE linkedin_id = ?').get(String(linkedinId)) ?? null;
    },
  };
}
