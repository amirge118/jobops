import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const DASHBOARD_PORT = 4177;

export function parseListeningPids(output) {
  return [...new Set(String(output || '')
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 1 && value <= 2_147_483_647))];
}

export function isJobOpsDashboardProcess(processInfo, rootDir) {
  if (!processInfo?.cwd || !processInfo?.command) return false;
  if (path.resolve(processInfo.cwd) !== path.resolve(rootDir)) return false;
  return /(?:^|\s)["']?(?:\S*\/)?scripts\/(?:web|start-local)\.mjs(?:["']?)(?:\s|$)/
    .test(processInfo.command);
}

export function findDashboardPids(port = DASHBOARD_PORT) {
  try {
    return parseListeningPids(execFileSync('/usr/sbin/lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

export function inspectDashboardProcess(pid) {
  try {
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const cwdOutput = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cwd = cwdOutput.split('\n').find((line) => line.startsWith('n'))?.slice(1) || '';
    return { command, cwd };
  } catch {
    return null;
  }
}

export async function waitUntilProcessStops(pid, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      if (error.code !== 'EPERM') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM') {
      throw new Error(`No permission to stop jobOps PID ${pid}. Run this command from the regular macOS Terminal.`);
    }
    throw error;
  }
}

export async function stopDashboard({
  port = DASHBOARD_PORT,
  rootDir,
  findPids = findDashboardPids,
  inspectProcess = inspectDashboardProcess,
  sendSignal = signalProcess,
  waitUntilStopped = waitUntilProcessStops,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  const pids = findPids(port);
  if (!pids.length) return { status: 'not_running', pids: [], forced: [] };

  const inspected = pids.map((pid) => ({ pid, processInfo: inspectProcess(pid) }));
  const foreign = inspected.find(({ processInfo }) => !isJobOpsDashboardProcess(processInfo, rootDir));
  if (foreign) {
    throw new Error(`Port ${port} is occupied by PID ${foreign.pid}, which is not a verified jobOps dashboard. Refusing to stop it.`);
  }

  for (const { pid } of inspected) sendSignal(pid, 'SIGTERM');
  const forced = [];
  for (const { pid, processInfo } of inspected) {
    if (await waitUntilStopped(pid)) continue;
    const current = inspectProcess(pid);
    if (!isJobOpsDashboardProcess(current, rootDir)
      || current.command !== processInfo.command
      || path.resolve(current.cwd) !== path.resolve(processInfo.cwd)) {
      throw new Error(`PID ${pid} changed while stopping jobOps. Refusing to force-stop it.`);
    }
    sendSignal(pid, 'SIGKILL');
    forced.push(pid);
    if (!await waitUntilStopped(pid)) {
      throw new Error(`jobOps PID ${pid} did not stop.`);
    }
  }
  return { status: 'stopped', pids, forced };
}
