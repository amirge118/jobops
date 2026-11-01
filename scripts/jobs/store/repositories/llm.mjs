import { parseSources, israelDay, parseJson } from '../shared.mjs';

const SOURCE_KINDS = new Set(['ats', 'whatsapp', 'linkedin']);

function normalizeSourceMix(mix) {
  if (!mix || typeof mix !== 'object') return null;
  const clean = Object.fromEntries(Object.entries(mix)
    .filter(([source, count]) => (SOURCE_KINDS.has(source) || source === 'other') && Number.isInteger(count) && count > 0));
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export function createLlmRepository({ db, store }) {
  return {
    async recordCodexCall(entry = {}) {
      const at = Number(entry.at) || Date.now();
      const usage = entry.usage || {};
      const int = (value) => (value != null && Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
      await db.prepare(`
        INSERT INTO codex_calls (run_id, purpose, model, reasoning_effort, items, input_tokens, cached_input_tokens,
          output_tokens, reasoning_tokens, duration_ms, ok, error_code, created_at, source_mix, error_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        int(entry.runId), String(entry.purpose || 'other').slice(0, 32), entry.model ? String(entry.model).slice(0, 64) : null,
        entry.reasoningEffort ? String(entry.reasoningEffort).slice(0, 16) : null, int(entry.items),
        entry.usage ? int(usage.inputTokens) : null, entry.usage ? int(usage.cachedInputTokens) : null,
        entry.usage ? int(usage.outputTokens) : null, entry.usage ? int(usage.reasoningTokens) : null,
        int(entry.durationMs), entry.ok ? 1 : 0, entry.errorCode ? String(entry.errorCode).slice(0, 64) : null, at,
        normalizeSourceMix(entry.sourceMix),
        entry.ok || !entry.errorReason ? null : String(entry.errorReason).slice(0, 300),
      );
      if (entry.ok) await store.noteLlmSuccess(at);
      else if (entry.errorCode === 'codex_usage_limit' && entry.limitUntil) {
        await store.setLlmBlocked({ until: entry.limitUntil, reason: 'usage_limit', at });
      }
      await db.prepare('DELETE FROM codex_calls WHERE created_at < ?').run(at - 90 * 24 * 60 * 60 * 1000);
    },

    async recordSourceOutcome({ source, suitable, at = Date.now() }) {
      const kind = SOURCE_KINDS.has(source) ? source : 'other';
      await db.prepare(`
        INSERT INTO source_daily_outcomes (day, source, scored, suitable) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, source) DO UPDATE SET scored = scored + 1, suitable = suitable + excluded.suitable
      `).run(israelDay(at), kind, suitable ? 1 : 0);
    },

    // Daily Codex tokens per source. A call's tokens are split equally among
    // the jobs in its batch (every job shares the batch's fixed prompt, and
    // page text is capped at a similar length). Calls tied to no job (quota
    // probe, company research) are "system"; calls recorded before source
    // attribution existed are "unclassified".
    async dailyUsageBySource({ days = 14, now = Date.now() } = {}) {
      const boundedDays = Math.max(1, Math.min(60, Number(days) || 14));
      const dayKeys = Array.from({ length: boundedDays }, (_, index) => israelDay(now - index * 24 * 60 * 60 * 1000));
      const sinceMs = now - (boundedDays + 1) * 24 * 60 * 60 * 1000;
      const rows = new Map();
      const rowFor = (day, source) => {
        const key = `${day}|${source}`;
        if (!rows.has(key)) rows.set(key, { day, source, tokens: 0, calls: 0, items: 0, scored: 0, suitable: 0, limited: 0 });
        return rows.get(key);
      };
      const calls = await db.prepare(`
        SELECT purpose, items, input_tokens, output_tokens, ok, error_code, created_at, source_mix
        FROM codex_calls WHERE created_at >= ?
      `).all(sinceMs);
      const wanted = new Set(dayKeys);
      for (const call of calls) {
        const day = israelDay(call.created_at);
        if (!wanted.has(day)) continue;
        const tokens = Number(call.input_tokens || 0) + Number(call.output_tokens || 0);
        const mix = parseJson(call.source_mix, null);
        const shares = mix && Object.values(mix).some((count) => count > 0)
          ? Object.entries(mix).filter(([, count]) => count > 0)
          : [[['probe', 'company_research', 'gap_coverage'].includes(call.purpose) ? 'system' : 'unclassified', 1]];
        const total = shares.reduce((sum, [, count]) => sum + Number(count), 0);
        for (const [source, count] of shares) {
          const row = rowFor(day, source);
          row.tokens += tokens * (Number(count) / total);
          row.calls += Number(count) / total;
          if (call.error_code === 'codex_usage_limit') row.limited += Number(count) / total;
        }
      }
      for (const outcome of await db.prepare('SELECT * FROM source_daily_outcomes WHERE day IN (' + dayKeys.map(() => '?').join(',') + ')').all(...dayKeys)) {
        const row = rowFor(outcome.day, outcome.source);
        row.scored += Number(outcome.scored || 0);
        row.suitable += Number(outcome.suitable || 0);
      }
      const list = [...rows.values()].map((row) => ({
        ...row,
        tokens: Math.round(row.tokens),
        calls: Math.round(row.calls * 10) / 10,
        limited: Math.round(row.limited * 10) / 10,
        tokensPerSuitable: row.suitable ? Math.round(row.tokens / row.suitable) : null,
      }));
      return { days: dayKeys, rows: list.sort((a, b) => b.day.localeCompare(a.day) || a.source.localeCompare(b.source)) };
    },

    async getLlmQuota() {
      const row = await db.prepare('SELECT * FROM llm_state WHERE id = 1').get();
      return {
        blockedUntil: row?.blocked_until ?? null,
        blockedReason: row?.blocked_reason ?? null,
        blockedAt: row?.blocked_at ?? null,
        lastSuccessAt: row?.last_success_at ?? null,
        lastSkipAt: row?.last_skip_at ?? null,
      };
    },

    async setLlmBlocked({ until, reason = 'usage_limit', at = Date.now() }) {
      await db.prepare(`
        INSERT INTO llm_state (id, blocked_until, blocked_reason, blocked_at, updated_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET blocked_until = MAX(COALESCE(blocked_until, 0), excluded.blocked_until),
          blocked_reason = excluded.blocked_reason, blocked_at = excluded.blocked_at, updated_at = excluded.updated_at
      `).run(Number(until), String(reason).slice(0, 64), Number(at), Number(at));
    },

    async noteLlmSuccess(at = Date.now()) {
      await db.prepare(`
        INSERT INTO llm_state (id, last_success_at, blocked_until, updated_at) VALUES (1, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET last_success_at = excluded.last_success_at, blocked_until = NULL,
          blocked_reason = NULL, updated_at = excluded.updated_at
      `).run(Number(at), Number(at));
    },

    async noteLlmSkip(at = Date.now()) {
      await db.prepare(`
        INSERT INTO llm_state (id, last_skip_at, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_skip_at = excluded.last_skip_at, updated_at = excluded.updated_at
      `).run(Number(at), Number(at));
    },

    // Totals per purpose over a window, plus per-run rows for the latest runs.
    async summarizeCodexUsage({ sinceMs = 0, untilMs = Date.now(), recentRuns = 8 } = {}) {
      const totals = (await db.prepare(`
        SELECT purpose,
          COUNT(*) AS calls, SUM(ok) AS ok_calls, SUM(CASE WHEN error_code = 'codex_usage_limit' THEN 1 ELSE 0 END) AS limited,
          COALESCE(SUM(items), 0) AS items,
          COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_calls,
          GROUP_CONCAT(DISTINCT model) AS models
        FROM codex_calls WHERE created_at >= ? AND created_at <= ?
        GROUP BY purpose ORDER BY purpose
      `).all(Number(sinceMs), Number(untilMs))).map((row) => ({
        purpose: row.purpose, calls: row.calls, okCalls: row.ok_calls, limited: row.limited, items: row.items,
        inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens, outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens, measuredCalls: row.measured_calls,
        models: row.models ? row.models.split(',') : [],
      }));
      const runs = (await db.prepare(`
        SELECT c.run_id AS runId, MIN(c.created_at) AS startedAt, COUNT(*) AS calls, COALESCE(SUM(c.items), 0) AS items,
          COALESCE(SUM(c.input_tokens), 0) + COALESCE(SUM(c.output_tokens), 0) AS totalTokens,
          COALESCE(SUM(c.cached_input_tokens), 0) AS cachedInputTokens,
          SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS failedCalls,
          r.sources AS sources
        FROM codex_calls c LEFT JOIN runs r ON r.id = c.run_id
        WHERE c.run_id IS NOT NULL
        GROUP BY c.run_id ORDER BY c.run_id DESC LIMIT ?
      `).all(Math.max(1, Math.min(50, Number(recentRuns) || 8)))).map((row) => ({ ...row, sources: parseSources(row.sources) }));
      return { totals, runs, quota: await store.getLlmQuota() };
    },
  };
}
