import { companyIdentityKey } from '../../core.mjs';
import { COMPANY_STATUSES, CompanyRegistryError, companySourceKey, companySourcePortalFields, normalizeCompanyCandidate, normalizeCompanyIdentity, normalizeCompanySource, resolveCompanyCandidate } from '../../company-registry.mjs';
import { parseSources, parseJson } from '../shared.mjs';

function companyId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new CompanyRegistryError('invalid_company_id', 'Company id must be a positive integer');
  }
  return id;
}

function mapCompanySource(row) {
  if (!row) return null;
  const config = parseJson(row.source_config_json, {});
  const source = {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    boardKey: row.board_key,
    careersUrl: row.careers_url,
    apiUrl: row.api_url,
    enabled: Boolean(row.enabled),
    health: row.health,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    verificationStatus: row.verification_status || 'unverified',
    lastJobCount: row.last_job_count == null ? null : Number(row.last_job_count),
    lastErrorReason: row.last_error_reason || null,
    lastProbeAt: row.last_probe_at == null ? null : Number(row.last_probe_at),
    discoveryEvidence: parseJson(row.discovery_evidence_json, []),
  };
  return config && Object.keys(config).length ? { ...source, config } : source;
}

function mapCompany(row, sources = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    canonicalDomain: row.canonical_domain,
    status: row.status,
    discoverySource: row.discovery_source,
    resolutionStatus: row.resolution_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    autoResolve: row.auto_status ? {
      status: row.auto_status,
      reason: row.auto_reason || null,
      detail: row.auto_detail || null,
      checkedAt: row.auto_checked_at ?? null,
      nextAt: row.auto_next_at ?? null,
    } : null,
    sources,
  };
}

export function createCompaniesRepository({ db, store }) {
  const getCompanyRow = db.prepare('SELECT * FROM companies WHERE id = ?');
  const listCompanySources = db.prepare('SELECT * FROM company_job_sources WHERE company_id = ? ORDER BY id');
  const getCompanySnapshot = async (id) => {
    const row = await getCompanyRow.get(id);
    return row ? mapCompany(row, (await listCompanySources.all(id)).map(mapCompanySource)) : null;
  };

  const findCompanyForCandidate = db.prepare(`
    SELECT c.*
    FROM companies c
    LEFT JOIN company_job_sources s ON s.company_id = c.id
    WHERE (@sourceKey IS NOT NULL AND s.source_key = @sourceKey)
       OR (@canonicalDomain IS NOT NULL AND c.canonical_domain = @canonicalDomain)
       OR c.normalized_name = @normalizedName
    ORDER BY
      CASE WHEN @sourceKey IS NOT NULL AND s.source_key = @sourceKey THEN 0 ELSE 1 END,
      CASE WHEN @canonicalDomain IS NOT NULL AND c.canonical_domain = @canonicalDomain THEN 0 ELSE 1 END,
      c.id
    LIMIT 1
  `);
  const findCompanyForSourceKey = db.prepare(`
    SELECT c.*
    FROM companies c
    JOIN company_job_sources s ON s.company_id = c.id
    WHERE s.source_key = ?
    LIMIT 1
  `);

  const saveCompanySource = async (targetCompanyId, input, at = Date.now()) => {
    const id = companyId(targetCompanyId);
    if (!await getCompanyRow.get(id)) throw new CompanyRegistryError('company_not_found', 'Company was not found');
    const source = normalizeCompanySource(input);
    const sourceKey = companySourceKey(source);
    const existing = await db.prepare('SELECT * FROM company_job_sources WHERE source_key = ?').get(sourceKey);
    if (existing && existing.company_id !== id) {
      const error = new CompanyRegistryError('source_conflict', 'ATS source is already assigned to another company');
      error.ownerName = (await getCompanyRow.get(existing.company_id))?.name ?? null;
      throw error;
    }
    await db.prepare(`
      INSERT INTO company_job_sources (
        company_id, source_key, provider, board_key, careers_url, api_url,
        source_config_json, enabled, health, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        careers_url = excluded.careers_url,
        api_url = excluded.api_url,
        source_config_json = excluded.source_config_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
      WHERE company_job_sources.company_id = excluded.company_id
    `).run(
      id,
      sourceKey,
      source.provider,
      source.boardKey,
      source.careersUrl,
      source.apiUrl,
      JSON.stringify(source.config || {}),
      source.enabled ? 1 : 0,
      Number(at),
      Number(at),
    );
    return mapCompanySource(await db.prepare('SELECT * FROM company_job_sources WHERE source_key = ?').get(sourceKey));
  };

  return {
    async getCompanyStats() {
      const counts = Object.fromEntries(COMPANY_STATUSES.map((status) => [status, 0]));
      for (const row of await db.prepare('SELECT status, COUNT(*) AS count FROM companies GROUP BY status').all()) {
        if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count);
      }
      return counts;
    },

    async listCompanies({ status = null, limit = 500 } = {}) {
      if (status != null && !COMPANY_STATUSES.includes(status)) {
        throw new CompanyRegistryError('invalid_company_status', 'Company status is invalid');
      }
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 1_000));
      const rows = status == null
        ? await db.prepare('SELECT * FROM companies ORDER BY updated_at DESC, id DESC LIMIT ?').all(boundedLimit)
        : await db.prepare('SELECT * FROM companies WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(status, boundedLimit);
      if (!rows.length) return [];
      const wanted = new Set(rows.map((row) => row.id));
      const sourcesByCompany = new Map(rows.map((row) => [row.id, []]));
      for (const source of await db.prepare('SELECT * FROM company_job_sources ORDER BY id').all()) {
        if (wanted.has(source.company_id)) sourcesByCompany.get(source.company_id).push(mapCompanySource(source));
      }
      return rows.map((row) => mapCompany(row, sourcesByCompany.get(row.id)));
    },

    async getCompany(id) {
      return await getCompanySnapshot(companyId(id));
    },

    async upsertCompanyCandidate(input, at = Date.now()) {
      const candidate = normalizeCompanyCandidate(input);
      const normalizedName = normalizeCompanyIdentity(candidate.name);
      const sourceKey = candidate.source ? companySourceKey(candidate.source) : null;
      let row = await findCompanyForCandidate.get({
        sourceKey,
        canonicalDomain: candidate.canonicalDomain,
        normalizedName,
      });
      const save = db.transaction(async () => {
        if (!row) {
          const result = await db.prepare(`
            INSERT INTO companies (
              name, normalized_name, canonical_domain, status, discovery_source,
              resolution_status, created_at, updated_at
            ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)
          `).run(
            candidate.name,
            normalizedName,
            candidate.canonicalDomain,
            candidate.discoverySource,
            candidate.resolutionStatus,
            Number(at),
            Number(at),
          );
          row = await getCompanyRow.get(result.lastInsertRowid);
        } else {
          await db.prepare(`
            UPDATE companies SET
              canonical_domain = COALESCE(canonical_domain, ?),
              resolution_status = CASE WHEN ? = 'resolved' THEN 'resolved' ELSE resolution_status END,
              updated_at = ?
            WHERE id = ?
          `).run(candidate.canonicalDomain, candidate.resolutionStatus, Number(at), row.id);
        }
        if (candidate.source) {
          await saveCompanySource(row.id, candidate.source, at);
          if (candidate.source.provider !== 'unsupported') {
            await db.prepare(`
              DELETE FROM company_job_sources
              WHERE company_id = ? AND provider = 'unsupported'
            `).run(row.id);
          }
        }
        return await getCompanySnapshot(row.id);
      });
      const company = await save();
      return { company, sources: company.sources };
    },

    // Candidates the daily resolver should look at now: never checked, or
    // their retry time has come. includeAll ignores the retry time.
    async listCompaniesDueForAutoResolve({ now = Date.now(), includeAll = false } = {}) {
      const rows = await db.prepare(`
        SELECT id FROM companies
        WHERE status = 'candidate' AND (? OR auto_next_at IS NULL OR auto_next_at <= ?)
        ORDER BY created_at ASC
      `).all(includeAll ? 1 : 0, Number(now));
      return await Promise.all(rows.map(async (row) => await getCompanySnapshot(row.id)));
    },

    async recordAutoResolve(id, { status, reason = null, detail = null, at = Date.now(), nextAt = null }) {
      if (!['auto_watched', 'unscannable'].includes(status)) {
        throw new CompanyRegistryError('invalid_auto_status', 'Automatic resolution status is invalid');
      }
      const result = await db.prepare(`
        UPDATE companies SET auto_status = ?, auto_reason = ?, auto_detail = ?, auto_checked_at = ?, auto_next_at = ?
        WHERE id = ?
      `).run(status, reason, detail == null ? null : String(detail).slice(0, 300), Number(at), nextAt == null ? null : Number(nextAt), companyId(id));
      if (!result.changes) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      return true;
    },

    async upsertCompanySource(id, input, at = Date.now()) {
      return await saveCompanySource(id, input, at);
    },

    async resolveCompanyCandidateForJob(jobKey) {
      const job = await db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(String(jobKey ?? ''));
      if (!job) throw new CompanyRegistryError('job_not_found', 'Job was not found');
      if (!job.suitable || job.archived_at != null || job.active_status !== 'active') {
        throw new CompanyRegistryError('job_not_suitable', 'Only an active suitable job can resolve a company');
      }
      const sources = parseSources(job.sources_json);
      const discoverySource = sources.some((source) => /^whatsapp:/i.test(source)) ? 'whatsapp'
        : sources.some((source) => /^linkedin:/i.test(source)) ? 'linkedin' : 'ats';
      return {
        jobKey: job.job_key,
        ...resolveCompanyCandidate({
          company: job.company,
          // The evaluator stores the final posting URL in apply_url after following
          // WhatsApp shorteners; canonical_url may still be the redirect URL.
          jobUrl: job.apply_url,
          discoverySource,
        }),
      };
    },

    async approveCompany(id, at = Date.now()) {
      return await db.transaction(async () => {
        const normalizedId = companyId(id);
        const row = await getCompanyRow.get(normalizedId);
        if (!row) throw new CompanyRegistryError('company_not_found', 'Company was not found');
        const supported = await db.prepare(`
          SELECT 1 FROM company_job_sources
          WHERE company_id = ? AND enabled = 1 AND provider <> 'unsupported'
          LIMIT 1
        `).get(normalizedId);
        if (!supported) {
          throw new CompanyRegistryError('company_not_scannable', 'Company does not have a supported ATS source');
        }
        await db.prepare("UPDATE companies SET status = 'watched', updated_at = ? WHERE id = ?")
          .run(Number(at), normalizedId);
        return true;
      })();
    },

    async setCompanyStatus(id, status, at = Date.now()) {
      const normalizedId = companyId(id);
      if (status === 'watched') {
        throw new CompanyRegistryError('approval_required', 'Use approveCompany() to start watching a company');
      }
      if (!COMPANY_STATUSES.includes(status)) {
        throw new CompanyRegistryError('invalid_company_status', 'Company status is invalid');
      }
      const result = await db.prepare('UPDATE companies SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Number(at), normalizedId);
      if (!result.changes) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      return true;
    },

    // Guarantees a company ends up in 'candidate' — used when a person
    // explicitly flags a company as worth tracking (e.g. "בדוק חברה למעקב"
    // on the Decisions page), regardless of whatever status it happened to
    // have before: brand new, previously ignored, or previously paused.
    // Unlike upsertCompanyCandidate (which never touches an existing row's
    // status), this always lands the company where the person asked for it
    // to go. A company already watched is left alone — there's nothing to
    // move for a company already being tracked.
    async markCompanyAsCandidate(id, at = Date.now()) {
      const normalizedId = companyId(id);
      const company = await getCompanySnapshot(normalizedId);
      if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      if (company.status !== 'watched' && company.status !== 'candidate') {
        await store.setCompanyStatus(normalizedId, 'candidate', at);
        return await getCompanySnapshot(normalizedId);
      }
      return company;
    },

    // One-time repair for companies that importConfiguredCompanies previously
    // (incorrectly) forced to 'paused' just because their source wasn't
    // resolvable yet — before the fix above, that was indistinguishable from
    // the user deliberately pausing a company. Only touches rows matching
    // that exact, narrow signature, so a company the user genuinely paused
    // (any other discovery_source or resolution_status) is left untouched.
    // Safe to run more than once: nothing left to reclassify is a no-op.
    async reclassifyAutoPausedCompanies(at = Date.now()) {
      return await db.transaction(async () => {
        const rows = await db.prepare(`
          SELECT id, name FROM companies
          WHERE status = 'paused' AND discovery_source = 'configured' AND resolution_status = 'unsupported'
        `).all();
        for (const row of rows) await store.setCompanyStatus(row.id, 'candidate', at);
        return { reclassified: rows.map((row) => row.name) };
      })();
    },

    async importConfiguredCompanies(entries, at = Date.now()) {
      return await db.transaction(async () => {
        if (!Array.isArray(entries)) throw new CompanyRegistryError('invalid_import', 'Configured companies must be an array');
        if (entries.length > 2_000) throw new CompanyRegistryError('import_too_large', 'Configured company import exceeds 2000 entries');
        let imported = 0;
        let skipped = 0;
        for (const entry of entries) {
          try {
            const candidate = resolveCompanyCandidate({
              company: entry?.name,
              jobUrl: entry?.careers_url,
              discoverySource: 'configured',
            });
            if (entry?.provider || entry?.api) {
              candidate.source = normalizeCompanySource({
                careersUrl: entry.careers_url,
                provider: entry.provider,
                api: entry.api,
                config: entry,
                enabled: entry.enabled !== false,
              });
              candidate.resolutionStatus = candidate.source.provider === 'unsupported' ? 'unsupported' : 'resolved';
            } else {
              candidate.source = normalizeCompanySource({
                ...candidate.source,
                config: entry,
                enabled: candidate.source.provider !== 'unsupported' && entry?.enabled !== false,
              });
            }
            const existingSourceKey = candidate.source ? companySourceKey(candidate.source) : null;
            const normalizedName = normalizeCompanyIdentity(candidate.name);

            if (candidate.canonicalDomain == null && candidate.source) {
              const namedOwner = await db.prepare('SELECT * FROM companies WHERE normalized_name = ?').get(normalizedName);
              if (namedOwner?.discovery_source === 'configured') {
                await db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                  .run(Number(at), namedOwner.id);
                await db.prepare(`
                  DELETE FROM company_job_sources
                  WHERE company_id = ? AND provider = 'unsupported' AND careers_url = ? AND source_key <> ?
                `).run(namedOwner.id, candidate.source.careersUrl, existingSourceKey);
              }
              const legacyUrlOwner = await db.prepare(`
                SELECT c.* FROM companies c
                JOIN company_job_sources s ON s.company_id = c.id
                WHERE s.careers_url = ? AND s.provider = 'unsupported'
                LIMIT 1
              `).get(candidate.source.careersUrl);
              if (legacyUrlOwner?.discovery_source === 'configured' && legacyUrlOwner.normalized_name !== normalizedName) {
                await db.prepare('DELETE FROM company_job_sources WHERE company_id = ? AND careers_url = ? AND provider = ?')
                  .run(legacyUrlOwner.id, candidate.source.careersUrl, 'unsupported');
                await db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                  .run(Number(at), legacyUrlOwner.id);
              }
            }

            // Versions before 2026-09-10 treated a shared unsupported recruiting
            // host (notably comeet.com) as the company's canonical domain. That
            // could attach several configured companies' distinct board URLs to
            // the first imported company. The configured catalogue is exact enough
            // to repair only those stale configured-owned associations while still
            // preserving user status choices on each company.
            if (candidate.canonicalDomain == null && existingSourceKey) {
              const sourceOwner = await findCompanyForSourceKey.get(existingSourceKey);
              if (sourceOwner?.discovery_source === 'configured') {
                if (sourceOwner.canonical_domain) {
                  await db.prepare('UPDATE companies SET canonical_domain = NULL, updated_at = ? WHERE id = ?')
                    .run(Number(at), sourceOwner.id);
                }
                if (sourceOwner.normalized_name !== normalizedName) {
                  await db.prepare('DELETE FROM company_job_sources WHERE source_key = ?').run(existingSourceKey);
                }
              }
            }

            const preexisting = await findCompanyForCandidate.get({
              sourceKey: existingSourceKey,
              canonicalDomain: candidate.canonicalDomain,
              normalizedName,
            });
            const saved = await store.upsertCompanyCandidate(candidate, at);
            // A source that wasn't enabled/resolvable is the scanner's problem,
            // not a choice the user made — it belongs in 'candidate' (awaiting
            // a working source), never 'paused' (which means the user
            // deliberately doesn't want this company tracked, e.g. via the
            // "השהה" button). This block only ever revisits a company the sync
            // itself previously placed in 'candidate' for this exact reason, so
            // it never overwrites a status the user picked themselves.
            const autoCandidateUnsupportedUpgrade = preexisting?.status === 'candidate' &&
              preexisting?.resolution_status === 'unsupported' &&
              preexisting?.discovery_source === 'configured';
            if (!preexisting || autoCandidateUnsupportedUpgrade) {
              if (candidate.source?.enabled && entry?.enabled !== false) await store.approveCompany(saved.company.id, at);
              else await store.setCompanyStatus(saved.company.id, 'candidate', at);
            }
            imported += 1;
          } catch (error) {
            if (!(error instanceof CompanyRegistryError)) throw error;
            skipped += 1;
          }
        }
        return { imported, skipped };
      })();
    },

    async listWatchedCompanySources() {
      return (await db.prepare(`
        SELECT
          c.name,
          s.careers_url,
          s.provider,
          s.api_url,
          s.source_config_json,
          s.id AS source_id
        FROM company_job_sources s
        JOIN companies c ON c.id = s.company_id
        WHERE c.status = 'watched'
          AND s.enabled = 1
          AND s.provider <> 'unsupported'
        ORDER BY c.name COLLATE NOCASE, s.id
      `).all()).map((row) => {
        const source = normalizeCompanySource({
          provider: row.provider, careersUrl: row.careers_url,
          apiUrl: row.api_url, config: parseJson(row.source_config_json, {}), enabled: true,
        });
        return {
          name: row.name,
          careers_url: source.careersUrl,
          provider: source.provider,
          ...(source.apiUrl ? { api: source.apiUrl } : {}),
          ...companySourcePortalFields(source),
          enabled: true,
          sourceId: row.source_id,
        };
      });
    },

    async updateCompanySourceHealth(sourceId, { status, errorCode = null, at = Date.now() } = {}) {
      const id = Number(sourceId);
      if (!Number.isInteger(id) || id < 1) throw new CompanyRegistryError('invalid_source_id', 'Source id must be a positive integer');
      if (!['unknown', 'healthy', 'failed'].includes(status)) {
        throw new CompanyRegistryError('invalid_source_health', 'Company source health is invalid');
      }
      let safeErrorCode = null;
      if (status === 'failed') {
        safeErrorCode = String(errorCode || 'scan_failed').trim().toLowerCase();
        if (!/^[a-z0-9_:-]{1,64}$/.test(safeErrorCode)) {
          throw new CompanyRegistryError('invalid_error_code', 'Company source error code is invalid');
        }
      }
      const result = await db.prepare(`
        UPDATE company_job_sources SET
          health = ?,
          last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          last_error_code = ?,
          updated_at = ?
        WHERE id = ?
      `).run(status, Number(at), status, Number(at), safeErrorCode, Number(at), id);
      if (!result.changes) throw new CompanyRegistryError('source_not_found', 'Company source was not found');
      return true;
    },

    async recordCompanySourceProbe(sourceId, probe, evidenceUrls = [], at = Date.now()) {
      const id = Number(sourceId);
      if (!Number.isInteger(id) || id < 1) throw new CompanyRegistryError('invalid_source_id', 'Source id must be a positive integer');
      const status = String(probe?.status || '');
      const allowed = ['verified_jobs', 'verified_empty', 'blocked', 'failed', 'needs_adapter', 'external_only', 'stale'];
      if (!allowed.includes(status)) throw new CompanyRegistryError('invalid_probe_status', 'Company source probe status is invalid');
      const count = Number(probe?.count ?? 0);
      if (!Number.isInteger(count) || count < 0 || count > 5_000) {
        throw new CompanyRegistryError('invalid_probe_count', 'Company source probe count is invalid');
      }
      const errorCode = probe?.errorCode == null ? null : String(probe.errorCode).trim().toLowerCase();
      if (errorCode && !/^[a-z0-9_:-]{1,64}$/.test(errorCode)) {
        throw new CompanyRegistryError('invalid_error_code', 'Company source error code is invalid');
      }
      const reason = String(probe?.reason || '').replace(/[\r\n\t\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
      if (!Array.isArray(evidenceUrls) || evidenceUrls.length > 3) {
        throw new CompanyRegistryError('invalid_evidence', 'Company source evidence must contain at most three URLs');
      }
      const evidence = evidenceUrls.map((value) => String(value).slice(0, 2_048));
      const health = ['verified_jobs', 'verified_empty'].includes(status) ? 'healthy'
        : ['blocked', 'failed', 'stale'].includes(status) ? 'failed' : 'unknown';
      const result = await db.prepare(`
        UPDATE company_job_sources SET
          verification_status = ?, last_job_count = ?, last_error_reason = ?,
          last_error_code = ?, last_probe_at = ?, discovery_evidence_json = ?,
          health = ?, last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          updated_at = ?
        WHERE id = ?
      `).run(
        status, count, reason, errorCode, Number(at), JSON.stringify(evidence),
        health, Number(at), health, Number(at), Number(at), id,
      );
      if (!result.changes) throw new CompanyRegistryError('source_not_found', 'Company source was not found');
      return true;
    },

    // ---- Notifications ----------------------------------------------------

    // "Interested" in a job means its company is worth watching: it lands as a
    // candidate for one-click approval on the companies page (never demoting
    // a watched one). Best effort — a job without a usable company is skipped.
    async suggestCompanyForJob(jobKey, at = Date.now()) {
      try {
        const saved = await store.upsertCompanyCandidate(await store.resolveCompanyCandidateForJob(jobKey), at);
        return await store.markCompanyAsCandidate(saved.company.id, at);
      } catch {
        return null;
      }
    },

    // Per-company ATS progress: when each company's enabled sources were last
    // scanned successfully (the oldest one if they differ; null if never).
    // Keyed by normalized company identity, like recordCompanyScanResults.
    async getCompanyLastSuccessTimes() {
      const rows = await db.prepare(`
        SELECT c.name, MIN(s.last_success_at) AS lastSuccessAt, COUNT(s.last_success_at) AS succeeded, COUNT(*) AS total
        FROM company_job_sources s
        JOIN companies c ON c.id = s.company_id
        WHERE s.enabled = 1 AND s.provider <> 'unsupported'
        GROUP BY c.id
      `).all();
      return new Map(rows.map((row) => [
        normalizeCompanyIdentity(row.name),
        row.succeeded === row.total ? Number(row.lastSuccessAt) : null,
      ]));
    },

    async recordCompanyScanResults({ scannedNames = [], errorNames = [], at = Date.now() } = {}) {
      if (!Array.isArray(scannedNames) || !Array.isArray(errorNames) || scannedNames.length + errorNames.length > 10_000) {
        throw new CompanyRegistryError('invalid_scan_results', 'Company scan result list is invalid');
      }
      const errors = new Set(errorNames.map(normalizeCompanyIdentity));
      const scanned = new Set(scannedNames.map(normalizeCompanyIdentity));
      let updated = 0;
      const updateByName = db.prepare(`
        UPDATE company_job_sources SET
          health = ?, last_checked_at = ?,
          last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END,
          last_error_code = ?, updated_at = ?
        WHERE company_id IN (SELECT id FROM companies WHERE normalized_name = ?)
      `);
      const apply = db.transaction(async () => {
        for (const name of scanned) {
          if (errors.has(name)) continue;
          updated += (await updateByName.run('healthy', Number(at), 'healthy', Number(at), null, Number(at), name)).changes;
        }
        for (const name of errors) {
          updated += (await updateByName.run('failed', Number(at), 'failed', Number(at), 'scan_failed', Number(at), name)).changes;
        }
      });
      await apply();
      return { updated };
    },

    async isCompanyBlocked(company) {
      const key = companyIdentityKey(company);
      return Boolean(key && await db.prepare('SELECT 1 FROM blocked_companies WHERE company_key = ?').get(key));
    },

    async getHireMeTechTarget(jobId) {
      return await db.prepare('SELECT * FROM hiremetech_targets WHERE job_id = ?').get(String(jobId)) || null;
    },

    async saveHireMeTechTarget(jobId, { company = null, targetUrl = null, method = null, error = null, at = Date.now() } = {}) {
      await db.prepare(`
        INSERT INTO hiremetech_targets (job_id, company, target_url, method, error, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          company = excluded.company, target_url = excluded.target_url, method = excluded.method,
          error = excluded.error, resolved_at = excluded.resolved_at
      `).run(String(jobId), company, targetUrl, method, error == null ? null : String(error).slice(0, 200), Number(at));
    },
  };
}
