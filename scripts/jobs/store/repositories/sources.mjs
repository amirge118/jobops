export function createSourcesRepository({ db, store }) {
  return {
    async recordSourceScanStats(rows, { runId = null, at = Date.now() } = {}) {
      const insert = db.prepare(`
        INSERT INTO source_scan_stats (
          run_id, scanned_at, source_kind, seconds, found, filtered_title, filtered_location,
          filtered_recency, candidates, scored, suitable, failed, errors
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const count = (value) => Math.max(0, Math.trunc(Number(value) || 0));
      await db.transaction(async () => {
        for (const row of rows) {
          if (!['ats', 'whatsapp', 'linkedin'].includes(row.source)) continue;
          await insert.run(
            runId, Number(at), row.source, Number.isFinite(row.seconds) ? row.seconds : null,
            count(row.found), count(row.filteredTitle), count(row.filteredLocation), count(row.filteredRecency),
            count(row.candidates), count(row.scored), count(row.suitable), count(row.failed), count(row.errors),
          );
        }
      })();
    },

    // Raw facts behind the source-value metrics (scripts/jobs/source-value.mjs).
    async listSourceValueFacts({ since = 0 } = {}) {
      const from = Number(since) || 0;
      return {
        scans: await db.prepare(`
          SELECT scanned_at AS scannedAt, source_kind AS source, seconds, found,
            filtered_title AS filteredTitle, filtered_location AS filteredLocation,
            filtered_recency AS filteredRecency, candidates, scored, suitable, failed, errors
          FROM source_scan_stats WHERE scanned_at >= ? ORDER BY scanned_at
        `).all(from),
        sightings: await db.prepare(`
          SELECT s.job_key AS jobKey, s.source_kind AS source, s.company, s.first_seen_at AS firstSeenAt,
            j.first_scored_at AS firstScoredAt, j.first_suitable_at AS firstSuitableAt, d.decision
          FROM job_source_sightings s
          LEFT JOIN jobs j ON j.job_key = s.job_key
          LEFT JOIN job_decisions d ON d.job_key = s.job_key
          WHERE s.first_seen_at >= ? OR j.first_suitable_at >= ?
        `).all(from, from),
        watchedCompanies: (await db.prepare("SELECT name FROM companies WHERE status = 'watched' ORDER BY name COLLATE NOCASE")
          .all()).map((row) => row.name),
      };
    },

    async isSourceEnabled(source) {
      const row = await db.prepare('SELECT enabled FROM source_settings WHERE source = ?').get(String(source));
      return row ? Boolean(row.enabled) : true;
    },

    async setSourceEnabled(source, enabled, at = Date.now()) {
      return await db.transaction(async () => {
        await db.prepare(`
          INSERT INTO source_settings (source, enabled, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
        `).run(String(source), enabled ? 1 : 0, at);
        return await store.isSourceEnabled(source);
      })();
    },
  };
}
