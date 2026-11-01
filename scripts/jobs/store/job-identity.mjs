// One company + one role = one job. Shared by the jobs and evaluations repositories.

import { normalizeCompanyRole } from '../core.mjs';
import { parseSources, sourceKinds } from './shared.mjs';

export function createJobIdentity(db) {
  const insertSourceSighting = db.prepare(`
    INSERT OR IGNORE INTO job_source_sightings (job_key, source_kind, company, first_seen_at) VALUES (?, ?, ?, ?)
  `);
  // First time each source kind saw a job — survives rejection and archiving,
  // so a source's exclusive finds and lead time can be measured later.
  const insertSourceLabel = db.prepare('INSERT OR IGNORE INTO job_source_labels (job_key, label, first_seen_at) VALUES (?, ?, ?)');
  const noteSourceSighting = async (jobKey, source, company, seenAt) => {
    const [kind] = sourceKinds(source ? [source] : []);
    if (kind) await insertSourceSighting.run(jobKey, kind, String(company || '').trim().slice(0, 200) || null, Number(seenAt));
    if (/^(WhatsApp|LinkedIn): /.test(String(source || ''))) await insertSourceLabel.run(jobKey, String(source).slice(0, 200), Number(seenAt));
  };

  // A duplicate row keeps only its URL and identity key; company+role matches
  // always land on the representative.
  const findByIdentity = db.prepare(`
    SELECT * FROM jobs
    WHERE canonical_url = @canonicalUrl
       OR (@companyRoleKey <> '::' AND company_role_key = @companyRoleKey AND duplicate_of IS NULL)
    ORDER BY canonical_url = @canonicalUrl DESC
    LIMIT 1
  `);

  // ---- Job identity dedup ----------------------------------------------
  // One company + one role = one job, whatever source or URL it came from.
  // Extra postings become duplicate_of rows: technical identity only, never
  // scored, never shown, their sources credited to the representative.

  const getJobRow = db.prepare('SELECT * FROM jobs WHERE job_key = ?');
  const findTwinRow = db.prepare(`
    SELECT * FROM jobs
    WHERE company_role_key = ? AND job_key <> ? AND duplicate_of IS NULL
    ORDER BY archived_at IS NOT NULL DESC,
      (evaluated_at IS NOT NULL AND last_error_code IS NULL) DESC,
      first_seen_at ASC
    LIMIT 1
  `);

  const representativeOf = async (row) => {
    let current = row;
    for (let hops = 0; current?.duplicate_of && hops < 10; hops += 1) {
      const next = await getJobRow.get(current.duplicate_of);
      if (!next) break;
      current = next;
    }
    return current;
  };

  // Whether a twin's existing verdict settles the job for this evaluation
  // context. A local verdict (no profile hash) defers to any real decision.
  const isSettled = (row, { profileHash = null, criteriaVersion = null } = {}) => {
    if (row.archived_at) return true;
    if (!row.evaluated_at || row.last_error_code) return false;
    if (!profileHash || !row.profile_hash) return true;
    return row.profile_hash === profileHash && row.criteria_version === criteriaVersion;
  };

  const markDuplicateRow = db.transaction(async (duplicateKey, representativeKey, at) => {
    const duplicate = await getJobRow.get(duplicateKey);
    const representative = await representativeOf(await getJobRow.get(representativeKey));
    if (!duplicate || !representative || representative.job_key === duplicate.job_key) return null;
    const repKey = representative.job_key;

    const representativeIsLive = !representative.archived_at &&
      (!representative.evaluated_at || representative.suitable);
    if (representativeIsLive) {
      const sources = new Set([...parseSources(representative.sources_json), ...parseSources(duplicate.sources_json)]);
      await db.prepare('UPDATE jobs SET sources_json = ?, last_seen_at = MAX(last_seen_at, ?) WHERE job_key = ?')
        .run(JSON.stringify([...sources]), duplicate.last_seen_at, repKey);
    } else {
      await db.prepare('UPDATE jobs SET last_seen_at = MAX(last_seen_at, ?) WHERE job_key = ?').run(duplicate.last_seen_at, repKey);
    }
    await db.prepare('UPDATE jobs SET duplicate_of = ? WHERE duplicate_of = ?').run(repKey, duplicate.job_key);
    await db.prepare(`
      INSERT INTO job_source_sightings (job_key, source_kind, company, first_seen_at)
      SELECT ?, source_kind, company, first_seen_at FROM job_source_sightings WHERE job_key = ?
      ON CONFLICT(job_key, source_kind) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)
    `).run(repKey, duplicate.job_key);
    await db.prepare('DELETE FROM job_source_sightings WHERE job_key = ?').run(duplicate.job_key);
    await db.prepare('UPDATE OR IGNORE job_decisions SET job_key = ? WHERE job_key = ?').run(repKey, duplicate.job_key);
    await db.prepare('DELETE FROM job_decisions WHERE job_key = ?').run(duplicate.job_key);
    await db.prepare('UPDATE OR IGNORE gap_observations SET job_key = ? WHERE job_key = ?').run(repKey, duplicate.job_key);
    await db.prepare('DELETE FROM gap_observations WHERE job_key = ?').run(duplicate.job_key);
    await db.prepare(`
      UPDATE jobs SET
        duplicate_of = @repKey,
        possible_duplicate_of = NULL,
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
        apply_url = canonical_url,
        sources_json = '[]',
        evaluated_at = COALESCE(evaluated_at, @at),
        last_error_code = NULL,
        last_error_reason = NULL
      WHERE job_key = @jobKey
    `).run({ repKey, at, jobKey: duplicate.job_key });
    await db.prepare('DELETE FROM job_pages WHERE canonical_url = ?').run(duplicate.canonical_url);
    await db.prepare('UPDATE linkedin_postings SET external_canonical_url = NULL WHERE job_key = ?').run(duplicate.job_key);
    return repKey;
  });

  // Groups of rows sharing a real company+role key, with the row that should
  // represent each group first. Key recomputation covers rows written before
  // the current normalization (rejected rows keep only the key itself).
  const planIdentityDedup = async () => {
    const rekeys = [];
    for (const row of await db.prepare('SELECT job_key, company, title, company_role_key FROM jobs').all()) {
      const [keyCompany = '', keyTitle = ''] = String(row.company_role_key || '').split('::');
      const key = normalizeCompanyRole(row.company || keyCompany, row.title || keyTitle);
      if (key !== row.company_role_key) rekeys.push({ jobKey: row.job_key, from: row.company_role_key, to: key });
    }
    const keyOf = new Map(rekeys.map(({ jobKey, to }) => [jobKey, to]));
    const byKey = new Map();
    for (const row of await db.prepare(`
      SELECT j.*, d.job_key IS NOT NULL AS has_decision
      FROM jobs j LEFT JOIN job_decisions d ON d.job_key = j.job_key
      WHERE j.duplicate_of IS NULL
    `).all()) {
      const key = keyOf.get(row.job_key) ?? row.company_role_key;
      if (!key || key === '::') continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    const rank = (row) => [
      row.has_decision ? 0 : 1,
      row.archived_at ? 0 : 1,
      row.suitable && row.active_status === 'active' && row.evaluated_at ? 0 : 1,
      row.evaluated_at && !row.last_error_code ? 0 : 1,
      row.first_seen_at,
    ];
    const compare = (left, right) => {
      const a = rank(left);
      const b = rank(right);
      for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
      return 0;
    };
    const groups = [...byKey.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => {
        const [representative, ...duplicates] = [...rows].sort(compare);
        return { key, representative, duplicates };
      })
      .sort((left, right) => right.duplicates.length - left.duplicates.length || left.key.localeCompare(right.key));
    return { rekeys, groups };
  };

  return { noteSourceSighting, findByIdentity, getJobRow, findTwinRow, representativeOf, isSettled, markDuplicateRow, planIdentityDedup };
}
