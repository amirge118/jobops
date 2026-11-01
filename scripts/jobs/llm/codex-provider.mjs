import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  inMemoryBlockedUntil, isUsageLimitMessage, noteUsageLimit, parseCodexJsonl, parseUsageLimitReset, reportCodexCall,
} from '../llm-usage.mjs';

const JOBS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SCHEMA_PATH = path.join(JOBS_DIR, 'job-score.schema.json');

// The Codex CLI bundled with the ChatGPT macOS app. Its location moved
// between app versions (a ChatGPT update in October 2026 moved it under
// codex-cli/bin), so every known layout is tried, newest first.
export const MACOS_APP_CODEX_PATHS = Object.freeze([
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
]);

export function resolveCodexBinary(config, { platform = process.platform, exists = fs.existsSync, env = process.env } = {}) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  if (config.scoring?.binary) return config.scoring.binary;
  const bundled = platform === 'darwin' ? MACOS_APP_CODEX_PATHS.find((candidate) => exists(candidate)) : null;
  return bundled || 'codex';
}

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

// "Lean" calls answer from the prompt alone (scoring, resume analysis), so
// the agent tooling Codex adds to every call is pure cost. Measured on
// 2026-09-29 with a one-word prompt on gpt-reserve: 14,192 input tokens by
// default, 10,041 with these features disabled, and 6,527 with Codex's base
// instructions replaced by a short task-only file. Calls that browse (company
// research) keep the full default agent.
export const LEAN_DISABLED_FEATURES = Object.freeze([
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'goals',
  'image_generation', 'multi_agent', 'personality', 'plugins', 'remote_plugin', 'skill_search', 'sleep_tool',
  'tool_suggest', 'view_image', 'shell_tool', 'unified_exec', 'hooks', 'mentions_v2', 'in_app_browser',
  'workspace_dependencies', 'skill_mcp_dependency_install', 'guardian_approval',
]);
export const LEAN_INSTRUCTIONS_PATH = path.join(JOBS_DIR, 'codex-instructions.md');

export async function runCodexExec({
  prompt,
  schemaPath = DEFAULT_SCHEMA_PATH,
  cwd,
  model,
  reasoningEffort = null,
  purpose = 'other',
  items = null,
  sourceMix = null,
  binary,
  spawnProcess = spawn,
  timeoutMs = 120_000,
  liveSearch = false,
  maxOutputBytes = 2 * 1024 * 1024,
  lean = !liveSearch,
  now = Date.now,
}) {
  // Once this process has seen the account's usage limit, further calls
  // would only fail the same way; fail fast without spawning Codex.
  const blocked = inMemoryBlockedUntil(now());
  if (blocked) {
    throw new Error(`codex exec skipped: You've hit your usage limit (until ${new Date(blocked).toISOString()}).`);
  }
  const args = [
    ...(liveSearch ? ['--search'] : []),
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '-c', 'forced_login_method="chatgpt"',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--output-schema', schemaPath,
    '--color', 'never',
    '-C', cwd,
  ];
  if (model) args.push('--model', model);
  if (REASONING_EFFORTS.has(reasoningEffort)) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  if (lean) {
    args.push('-c', `model_instructions_file=${JSON.stringify(LEAN_INSTRUCTIONS_PATH)}`);
    for (const feature of LEAN_DISABLED_FEATURES) args.push('--disable', feature);
  }
  args.push('-');
  const startedAt = now();
  const report = (fields) => reportCodexCall({
    purpose, model: model || 'default', reasoningEffort: reasoningEffort || null, items, sourceMix,
    durationMs: now() - startedAt, at: startedAt, ...fields,
  });

  const childEnv = { ...process.env };
  // The scorer must use the cached ChatGPT login, never usage-based API credentials.
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;

  const result = await new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const appendBounded = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
        try { child.kill('SIGTERM'); } catch {}
        finish(reject, new Error('codex exec output exceeded the allowed size'));
        return current;
      }
      return next;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(reject, new Error(`Codex scoring timed out after ${timeoutMs}ms`));
    }, Math.max(1, Number(timeoutMs) || 120_000));
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else {
        // With --json the failure reason is an event on stdout, not stderr.
        const eventError = parseCodexJsonl(stdout).error;
        finish(reject, new Error(`codex exec exited with code ${code}: ${(eventError || stderr.trim()).slice(-1200)}`));
      }
    });
    child.stdin.end(prompt);
  }).catch((error) => {
    const limited = isUsageLimitMessage(error?.message);
    if (limited) noteUsageLimit(parseUsageLimitReset(error.message, now()));
    report({ ok: false, usage: null, errorCode: limited ? 'codex_usage_limit' : /timed out/i.test(error?.message) ? 'timeout' : 'failed',
      errorReason: safeFailureReason(error), limitUntil: limited ? inMemoryBlockedUntil(now()) || null : null });
    throw error;
  });

  const parsed = parseCodexJsonl(result.stdout);
  if (parsed.error && !parsed.message) {
    const limited = isUsageLimitMessage(parsed.error);
    if (limited) noteUsageLimit(parseUsageLimitReset(parsed.error, now()));
    report({ ok: false, usage: parsed.usage, errorCode: limited ? 'codex_usage_limit' : 'failed',
      errorReason: safeFailureReason(parsed.error), limitUntil: limited ? inMemoryBlockedUntil(now()) || null : null });
    throw new Error(`codex exec failed: ${parsed.error.slice(-1200)}`);
  }
  try {
    const answer = JSON.parse(String(parsed.message ?? '').trim());
    report({ ok: true, usage: parsed.usage, errorCode: null });
    return answer;
  } catch (error) {
    report({ ok: false, usage: parsed.usage, errorCode: 'invalid_json', errorReason: safeFailureReason(error) });
    throw new Error(`codex exec returned invalid JSON: ${error.message}`);
  }
}

export function safeFailureReason(error) {
  return String(error?.message || error || 'Unknown scoring failure')
    .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
    .replace(/([?&](?:token|key|code|session|auth)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    // Keep the END of the message, not the start: runCodexExec's error is
    // "codex exec exited with code N: <last 1200 chars of stderr>", and
    // codex's own CLI convention is to echo the whole session transcript
    // (banner, then the full prompt) before printing the actual failure —
    // e.g. "ERROR: You've hit your usage limit...". For a real scoring
    // batch the echoed prompt alone is thousands of characters, so slicing
    // from the front discarded the one part that actually explains the
    // failure and left every scoring failure looking identically generic.
    .slice(-240);
}
