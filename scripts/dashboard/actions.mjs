import { spawn } from 'node:child_process';

import { actionLabel, buildActionCommand, parseBacklogOptions, parseDashboardOptions } from '../jobs/dashboard.mjs';
import { createFailureCollector, describeFailure } from '../jobs/diagnostics.mjs';
import { createJobStore } from '../jobs/store.mjs';

const MAX_OUTPUT_CHARS = 12_000;

export function sanitizeCommandOutput(value) {
  return String(value)
    .replace(/<Buffer(?:\s+[0-9a-f]{2})+(?:\s+\.\.\.\s+\d+\s+more\s+bytes)?\s*>/gi, '<redacted-buffer>')
    .replace(/(['"])[A-Za-z0-9+/]{20,}={0,2}\1(?=\s*:\s*\{\s*chainKey)/g, "'[redacted-session]'");
}

function appendOutput(current, chunk) {
  return sanitizeCommandOutput(`${current}${chunk}`).slice(-MAX_OUTPUT_CHARS);
}

export function runCommand({ command, args }, rootDir, onOutput, { actionId, onSpawn = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(actionId ? { JOBOPS_ACTION_ID: String(actionId) } : {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let callbackFailed = false;
    const notify = (callback) => {
      if (callbackFailed) return;
      Promise.resolve().then(callback).catch((error) => {
        callbackFailed = true;
        child.kill('SIGTERM');
        reject(error);
      });
    };
    child.once('spawn', () => notify(async () => await onSpawn(child.pid)));
    child.stdout.on('data', (chunk) => notify(() => onOutput(chunk.toString(), 'stdout')));
    child.stderr.on('data', (chunk) => notify(() => onOutput(chunk.toString(), 'stderr')));
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0
      ? resolve()
      : reject(Object.assign(new Error('Command failed'), { exitCode: code, signal })));
  });
}

export function createActionController(config, execute = runCommand) {
  const action = {
    status: 'idle', name: null, label: null, startedAt: null,
    finishedAt: null, output: '', error: null,
  };

  async function startAction(name, rawOptions) {
    if (action.status === 'running') {
      const error = new Error('כבר מתבצעת פעולה. יש להמתין לסיומה.');
      error.statusCode = 409;
      throw error;
    }
    let options;
    try {
      options = name === 'scan'
        ? parseDashboardOptions(rawOptions, config.scan.maxLookbackDays)
        : name === 'process-backlog' ? parseBacklogOptions(rawOptions) : {};
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
    const command = buildActionCommand(name, options, config.rootDir);
    // Claimed before the first await, so a second request can't pass the check above.
    const statusBefore = action.status;
    action.status = 'running';
    let store;
    let id;
    try {
      store = createJobStore(config.jobsDbPath);
      id = await store.startAction(name);
    } catch (error) {
      action.status = statusBefore;
      store?.close();
      throw error;
    }
    const warnings = [];
    const collector = createFailureCollector(async (failure) => {
      warnings.push(failure);
      await store.updateAction(id, { warnings });
    });
    Object.assign(action, {
      id, status: 'running', name, label: actionLabel(name), startedAt: Date.now(),
      finishedAt: null, output: '', error: null,
    });

    Promise.resolve().then(() => execute(command, config.rootDir, (chunk, stream) => {
      action.output = appendOutput(action.output, chunk);
      return collector.push(chunk, stream);
    }, { actionId: id, onSpawn: async (childPid) => await store.updateAction(id, { childPid, warnings }) })).then(async () => {
      await collector.flush();
      const linked = await Promise.all((await store.getAction(id)).runIds.map(async (runId) => await store.getRun(runId)));
      action.status = linked.some((run) => run.status !== 'success') ? 'incomplete' : 'success';
      action.finishedAt = Date.now();
      await store.updateAction(id, { status: action.status, finishedAt: action.finishedAt, warnings });
    }).catch(async (error) => {
      await collector.flush();
      action.status = 'error';
      const failure = {
        ...describeFailure(error, error.signal ? 'process_interrupted' : 'command_failed'),
        ...(Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
        ...(/^SIG[A-Z0-9]+$/.test(error.signal || '') ? { signal: error.signal } : {}),
      };
      action.error = failure.reason;
      action.finishedAt = Date.now();
      await store.updateAction(id, { status: 'error', failure, warnings, finishedAt: action.finishedAt });
    }).finally(async () => {
      try { await store.pruneDiagnostics(); }
      catch { console.error('JobOps diagnostic retention unavailable; existing records were preserved.'); }
      store.close();
    }).catch(() => {
      action.status = 'error';
      action.finishedAt = Date.now();
      action.error = 'לא ניתן לשמור אבחון במסד הנתונים. בדוק הרשאות ושטח פנוי.';
      console.error('JobOps diagnostic storage unavailable; check permissions and disk space.');
    });
    return { ...action };
  }

  return { action, startAction };
}
