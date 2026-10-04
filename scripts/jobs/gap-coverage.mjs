// Decides which aggregated gap terms the current resume already covers in
// other words ("Model Context Protocol (MCP)" covers "MCP Servers"), which the
// personal area's plain text match cannot see. One Codex call per resume
// change (per batch of new terms); answers are cached per resume and version.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateGaps } from './gap-insights.mjs';
import { resolveCodexBinary, runCodexExec } from './score-job.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(MODULE_DIR, 'gap-coverage.schema.json');
const BATCH_SIZE = 100;

// Bump when the prompt changes so every term is judged again.
export const GAP_COVERAGE_VERSION = 'gap-coverage-v1';

export function coverageKeyOf(resumeHash) {
  return `${resumeHash}:${GAP_COVERAGE_VERSION}`;
}

function prompt(currentResume, terms) {
  return `You check which skill/experience terms a resume already covers.
Return only the JSON required by the output schema: one result per term id, covered true or false.

Resume:
${String(currentResume || '').trim()}

Rules:
- covered = true when the resume clearly shows the term, either verbatim or in clearly equivalent wording (e.g. "Model Context Protocol (MCP)" covers "MCP Servers"; "owned services from design through production operations" covers "End-to-End Ownership").
- covered = false for a related but different skill (Kafka does not cover RabbitMQ; LLM agents do not cover Model Training), for mere shared words, and for anything only implied.
- Years-of-experience terms are covered only when the resume's stated years meet them.
- When unsure, answer false: a false "covered" hides a real gap.

Terms:
${JSON.stringify(terms.map(({ id, term }) => ({ id, term })))}`;
}

export function createGapCoverageChecker({ config = {}, runCodex = runCodexExec } = {}) {
  const binary = resolveCodexBinary(config);
  return {
    version: GAP_COVERAGE_VERSION,
    // terms: [{ termKey, term }] → Map(termKey → covered). Terms missing from
    // the answer are left out, so the next run asks about them again.
    async check({ terms, currentResume }) {
      const covered = new Map();
      for (let start = 0; start < terms.length; start += BATCH_SIZE) {
        const batch = terms.slice(start, start + BATCH_SIZE).map((entry, index) => ({ ...entry, id: `t${index + 1}` }));
        const response = await runCodex({
          prompt: prompt(currentResume, batch),
          schemaPath: SCHEMA_PATH,
          cwd: config.rootDir || process.cwd(),
          model: config.resumeGap?.model || config.scoring?.model || null,
          reasoningEffort: config.resumeGap?.reasoningEffort || config.scoring?.reasoningEffort || null,
          purpose: 'gap_coverage',
          items: batch.length,
          binary,
          timeoutMs: Math.max(1, Number(config.resumeGap?.timeoutSeconds || config.scoring?.timeoutSeconds || 120)) * 1_000,
        });
        const byId = new Map(batch.map((entry) => [entry.id, entry.termKey]));
        for (const result of response.results || []) {
          const key = byId.get(result.id);
          if (key && typeof result.covered === 'boolean') covered.set(key, result.covered);
        }
      }
      return covered;
    },
  };
}

// Asks only about terms the personal area would still show and that were not
// judged against this resume yet, so an unchanged resume costs nothing.
export async function refreshGapCoverage({ store, checker, candidateContext, now = Date.now() }) {
  if (!candidateContext.resumeAvailable) return { status: 'skipped', reason: 'resume_unavailable', checked: 0, covered: 0 };
  const coverageKey = coverageKeyOf(candidateContext.resumeHash);
  const judged = store.listGapTermCoverage(coverageKey);
  const { topics } = aggregateGaps(store.listGapObservations(), {
    currentResumeText: candidateContext.currentResume, statuses: store.listGapTermStatuses(),
  });
  const pending = topics.flatMap((topic) => topic.rows)
    .filter((row) => !judged.has(row.key))
    .map((row) => ({ termKey: row.key, term: row.term }));
  if (pending.length === 0) return { status: 'complete', checked: 0, covered: 0 };

  const answers = await checker.check({ terms: pending, currentResume: candidateContext.currentResume });
  store.saveGapTermCoverage(coverageKey, [...answers].map(([termKey, covered]) => ({ termKey, covered })), now);
  const covered = [...answers.values()].filter(Boolean).length;
  return { status: answers.size < pending.length ? 'partial' : 'complete', checked: answers.size, covered };
}
