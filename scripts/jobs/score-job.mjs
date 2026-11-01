import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCodexBinary, runCodexExec, safeFailureReason } from './llm/codex-provider.mjs';
import { sourceMixOf } from './store.mjs';
import { calculateFitScore, decideFit } from './core.mjs';
import { buildScoringPrompt } from './candidate/scoring-prompt.mjs';
import { readCandidateContext } from './config.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.join(MODULE_DIR, 'job-score.schema.json');

export {
  LEAN_DISABLED_FEATURES, LEAN_INSTRUCTIONS_PATH, MACOS_APP_CODEX_PATHS, resolveCodexBinary, runCodexExec,
} from './llm/codex-provider.mjs';
// Exported so jobs.mjs can measure, per run, how close real page content
// comes to this cap — data to decide later, with actual numbers instead of
// a guess, whether it is safe to lower.
export const JOB_PAGE_TEXT_CAP_CHARS = 8_000;
function jobPayload({ candidate, page }) {
  return {
    jobKey: candidate.jobKey,
    source: candidate.source,
    knownCompany: candidate.company || 'unknown',
    knownTitle: candidate.title || 'unknown',
    url: page.finalUrl,
    pageText: page.content.slice(0, JOB_PAGE_TEXT_CAP_CHARS),
  };
}

const FIT_DIMENSIONS = ['cvMatch', 'seniority', 'roleScope', 'location', 'sector'];

// Keeps only the known dimensions, as bounded single-line strings, so a
// malformed model response can never smuggle extra fields into the stored
// breakdown.
function normalizeEvidence(evidence) {
  return Object.fromEntries(FIT_DIMENSIONS.map((key) => [
    key,
    String(evidence?.[key] ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
  ]));
}

function finalizeResult(config, item, extracted) {
  const score = calculateFitScore(extracted);
  const decision = decideFit({
    score,
    isActive: item.page.status === 'active',
    domainMatches: extracted.domainMatches,
    locationMatches: extracted.locationMatches,
    hasApplyUrl: Boolean(item.page.finalUrl),
    minimumScore: config.decision.minimumScore,
    exactMatchScore: config.decision.exactMatchScore,
  });

  return {
    jobKey: item.candidate.jobKey,
    company: extracted.company || item.candidate.company || 'Unknown company',
    title: extracted.title || item.candidate.title || 'Unknown role',
    summary: extracted.summary,
    score,
    fitLabel: decision.label,
    decisionReason: extracted.decisionReason,
    fitBreakdown: {
      cvMatch: extracted.cvMatch,
      seniority: extracted.seniority,
      roleScope: extracted.roleScope,
      location: extracted.location,
      sector: extracted.sector,
      evidence: normalizeEvidence(extracted.evidence),
      uncertainties: Array.isArray(extracted.uncertainties) ? extracted.uncertainties.slice(0, 3) : [],
    },
    suitable: decision.suitable,
    applyUrl: item.page.finalUrl,
    activeStatus: item.page.status,
  };
}

export function createJobScorer(config, {
  candidateContext,
  runCodex = runCodexExec,
} = {}) {
  if (config.scoring?.provider && config.scoring.provider !== 'codex') {
    throw new Error(`Unsupported scoring provider: ${config.scoring.provider}`);
  }

  const context = candidateContext ?? readCandidateContext(config);
  const promptPrefix = buildScoringPrompt(config, context);
  const batchSize = Math.max(1, Number(config.scoring?.batchSize) || 8);
  const schemaPath = config.scoring?.schemaPath
    ? path.resolve(config.rootDir, config.scoring.schemaPath)
    : DEFAULT_SCHEMA_PATH;
  const binary = resolveCodexBinary(config);

  async function scoreBatchSettled(items, { onProgress } = {}) {
    const results = [];
    const failures = [];
    for (let start = 0; start < items.length; start += batchSize) {
      const batch = items.slice(start, start + batchSize);
      const batchResults = [];
      const batchFailures = [];
      try {
        const prompt = `${promptPrefix}\n\nJobs to score:\n${JSON.stringify(batch.map(jobPayload), null, 2)}`;
        const response = await runCodex({
          prompt,
          schemaPath,
          cwd: config.rootDir,
          model: config.scoring?.model || null,
          reasoningEffort: config.scoring?.reasoningEffort || null,
          purpose: 'scoring',
          items: batch.length,
          sourceMix: sourceMixOf(batch.map((item) => item.candidate.source)),
          binary,
          timeoutMs: Math.max(1, Number(config.scoring?.timeoutSeconds || 120)) * 1000,
        });
        const byKey = new Map((response.results || []).map((result) => [result.jobKey, result]));
        for (const item of batch) {
          const extracted = byKey.get(item.candidate.jobKey);
          if (!extracted) throw new Error(`Codex scoring response is missing result for ${item.candidate.jobKey}`);
          const finalized = finalizeResult(config, item, extracted);
          results.push(finalized);
          batchResults.push(finalized);
        }
      } catch (error) {
        const reason = safeFailureReason(error);
        batchFailures.push(...batch.map((item) => ({
          jobKey: item.candidate.jobKey,
          code: 'scoring_failed',
          reason,
        })));
        failures.push(...batchFailures);
      }
      await onProgress?.({
        completed: Math.min(start + batch.length, items.length),
        total: items.length,
        failed: failures.length,
        results: batchResults,
        failures: batchFailures,
      });
    }
    return { results, failures };
  }

  return {
    provider: 'codex',
    profileHash: context.profileHash,

    scoreBatchSettled,

    async scoreBatch(items) {
      const settled = await scoreBatchSettled(items);
      if (settled.failures.length > 0) throw new Error(settled.failures[0].reason);
      return settled.results;
    },

    async score(item) {
      return (await this.scoreBatch([item]))[0];
    },
  };
}
