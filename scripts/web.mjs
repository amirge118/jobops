#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadJobsConfig } from './jobs/config.mjs';
import { actionLabel, buildActionCommand, parseDashboardOptions } from './jobs/dashboard.mjs';
import { createDemoEnvironment, runDemoAction } from './jobs/demo.mjs';
import { createJobStore } from './jobs/store.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_OUTPUT_CHARS = 12_000;
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 4177;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return { port, open: argv.includes('--open'), demo: argv.includes('--demo') };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body is too large');
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

export function sanitizeCommandOutput(value) {
  return String(value)
    .replace(/<Buffer(?:\s+[0-9a-f]{2})+(?:\s+\.\.\.\s+\d+\s+more\s+bytes)?\s*>/gi, '<redacted-buffer>')
    .replace(/(['"])[A-Za-z0-9+/]{20,}={0,2}\1(?=\s*:\s*\{\s*chainKey)/g, "'[redacted-session]'");
}

function appendOutput(current, chunk) {
  return sanitizeCommandOutput(`${current}${chunk}`).slice(-MAX_OUTPUT_CHARS);
}

function runCommand({ command, args }, rootDir, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => onOutput(chunk.toString()));
    child.stderr.on('data', (chunk) => onOutput(chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`הפעולה הסתיימה עם קוד ${code}`)));
  });
}

export function createDashboardServer({ config = loadJobsConfig(), execute = runCommand } = {}) {
  const staticDir = path.join(config.rootDir, 'web');
  const action = {
    status: 'idle',
    name: null,
    label: null,
    startedAt: null,
    finishedAt: null,
    output: '',
    error: null,
  };

  function snapshot() {
    const store = createJobStore(config.jobsDbPath);
    try {
      return {
        ...store.getDashboardSnapshot(),
        action: { ...action },
        settings: {
          defaultLookbackDays: Number(config.scan.defaultLookbackDays),
          maxLookbackDays: Number(config.scan.maxLookbackDays),
          minimumScore: Number(config.decision?.minimumScore ?? 4),
          exactMatchScore: Number(config.decision?.exactMatchScore ?? 4.5),
          demo: Boolean(config.demo),
          groups: (config.sources.whatsapp?.groups || []).map(({ name }) => ({ name })),
        },
      };
    } finally {
      store.close();
    }
  }

  function startAction(name, rawOptions) {
    if (action.status === 'running') {
      const error = new Error('כבר מתבצעת פעולה. יש להמתין לסיומה.');
      error.statusCode = 409;
      throw error;
    }
    const options = name === 'scan'
      ? parseDashboardOptions(rawOptions, config.scan.maxLookbackDays)
      : {};
    const command = buildActionCommand(name, options, config.rootDir);
    Object.assign(action, {
      status: 'running',
      name,
      label: actionLabel(name),
      startedAt: Date.now(),
      finishedAt: null,
      output: '',
      error: null,
    });

    execute(command, config.rootDir, (chunk) => {
      action.output = appendOutput(action.output, chunk);
    }).then(() => {
      action.status = 'success';
      action.finishedAt = Date.now();
    }).catch((error) => {
      action.status = 'error';
      action.error = error.message;
      action.finishedAt = Date.now();
    });
    return { ...action };
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, snapshot());
        return;
      }

      const actionMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/actions\/(scan|verify-groups|open-jobs|retry-failed|mark-read)$/)
        : null;
      if (actionMatch) {
        const body = await readJson(request);
        sendJson(response, 202, { action: startAction(actionMatch[1], body) });
        return;
      }

      const archiveMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})\/archive$/)
        : null;
      if (archiveMatch) {
        const store = createJobStore(config.jobsDbPath);
        try {
          if (!store.archiveJob(archiveMatch[1])) {
            sendJson(response, 404, { error: 'המשרה לא נמצאה או שכבר הועברה לארכיון' });
            return;
          }
        } finally {
          store.close();
        }
        sendJson(response, 200, { archived: true, state: snapshot() });
        return;
      }

      if (request.method !== 'GET') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }

      const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'styles.css', 'app.js'].includes(relativePath)) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const filePath = path.join(staticDir, relativePath);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
  });
}

export async function startDashboard(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const demo = options.demo ? createDemoEnvironment({ rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) : null;
  if (demo) demo.store.close();
  const config = demo?.config || loadJobsConfig();
  const server = createDashboardServer({ config, execute: demo ? runDemoAction : runCommand });
  if (demo) server.once('close', demo.cleanup);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, HOST, resolve);
  });
  const url = `http://${HOST}:${options.port}`;
  console.log(`jobOps dashboard: ${url}`);

  if (options.open) {
    const child = spawn('/usr/bin/open', ['-a', config.browser?.application || 'Google Chrome', url], {
      stdio: 'ignore',
    });
    child.once('error', (error) => console.error(`לא ניתן לפתוח את הדשבורד: ${error.message}`));
  }
  return { server, url };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startDashboard().catch((error) => {
    console.error(`הדשבורד לא עלה: ${error.message}`);
    process.exitCode = 1;
  });
}
