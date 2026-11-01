import { resolveCodexBinary, runCodexExec } from './codex-provider.mjs';

// The one place that decides which AI runs a structured request. Codex is the
// only provider for now, on the signed-in ChatGPT account and never an API key
// (hard rule 9). Who pays for other users' AI is still open; that decision
// becomes a second provider here. Older callers still reach Codex directly.
export function createLlm(config, { run = runCodexExec } = {}) {
  return (request) => run({
    cwd: config.rootDir,
    model: config.scoring?.model || null,
    binary: resolveCodexBinary(config),
    ...request,
  });
}
