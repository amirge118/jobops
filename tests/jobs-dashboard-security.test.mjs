import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDashboardServer } from '../scripts/web.mjs';
import { readJson } from '../scripts/dashboard/http.mjs';
import { guardRequest } from '../scripts/dashboard/request-guard.mjs';
import { createJobStore } from '../scripts/jobs/store.mjs';

const readyService = {
  inspect: async () => ({
    status: 'ready', checkedAt: Date.now(), stale: false,
    browser: { status: 'ready' }, scorer: { status: 'ready' }, collector: { status: 'ready' },
  }),
};

// fetch() forbids setting Host and Origin, so raw requests stand in for a browser.
function send(port, { method = 'GET', pathname = '/api/jobs', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function startServer(context) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-guard-'));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const jobsDbPath = path.join(rootDir, 'jobs.db');
  const config = {
    rootDir, jobsDbPath, scan: { defaultLookbackDays: 1, maxLookbackDays: 7 },
    sources: { ats: { enabled: true }, whatsapp: { enabled: true, groups: [] } },
    filters: { domains: ['Backend'] },
  };
  const server = await createDashboardServer({ config, readiness: readyService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  return { port: server.address().port, jobsDbPath };
}

const TERM_STATUS = { method: 'POST', pathname: '/api/personal-area/term-status' };
const termBody = JSON.stringify({ term: 'kafka', status: 'hidden' });

test('a page from another site cannot write, however the request is dressed', async (context) => {
  const { port, jobsDbPath } = await startServer(context);
  const host = `127.0.0.1:${port}`;
  const json = { 'Content-Type': 'application/json', Host: host };
  const attempts = [
    { ...TERM_STATUS, headers: { ...json, Origin: 'https://evil.example' }, body: termBody },
    { ...TERM_STATUS, headers: { ...json, Origin: 'null' }, body: termBody },
    { ...TERM_STATUS, headers: { ...json, Origin: `http://127.0.0.1:${port + 1}` }, body: termBody },
    { ...TERM_STATUS, headers: { ...json, 'Sec-Fetch-Site': 'cross-site' }, body: termBody },
    // A bodyless write can't be stopped by Content-Type, only by its origin.
    { method: 'POST', pathname: '/api/jobs/archive-failed', headers: { Host: host, Origin: 'https://evil.example' } },
  ];
  for (const attempt of attempts) {
    const response = await send(port, attempt);
    assert.equal(response.status, 403, JSON.stringify(attempt.headers));
    assert.match(response.text, /not allowed/);
  }
  const store = createJobStore(jobsDbPath);
  context.after(() => store.close());
  assert.deepEqual(await store.listGapTermStatuses(), [], 'nothing was written');
});

test('a form or text/plain post, the kind needing no preflight, is refused', async (context) => {
  const { port } = await startServer(context);
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const response = await send(port, { ...TERM_STATUS, headers: { 'Content-Type': contentType }, body: termBody });
    assert.equal(response.status, 415, contentType);
  }
  assert.equal((await send(port, { ...TERM_STATUS, body: termBody })).status, 415, 'no content type at all');
});

test('every write route is behind the guard', async (context) => {
  const { port } = await startServer(context);
  const pathnames = [
    '/api/health', '/api/personal-area/term-status', '/api/linkedin/enabled', '/api/whatsapp/history',
    '/api/companies/resolve', '/api/companies/research', '/api/companies/1/manual-source', '/api/companies/1/browser-probe',
    '/api/companies/1/watch', '/api/companies/1/status', '/api/actions/scan', '/api/jobs/aaaaaaaaaaaaaaaaaaaaaaaa/decision',
    '/api/jobs/archive-failed',
  ];
  for (const pathname of pathnames) {
    const response = await send(port, { method: 'POST', pathname, headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 403, pathname);
  }
});

test('a foreign Host is refused on reads too, which blocks DNS rebinding', async (context) => {
  const { port } = await startServer(context);
  assert.equal((await send(port, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await send(port, { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await send(port, { pathname: '/decisions', headers: { Host: 'evil.example' } })).status, 403);
});

test('the dashboard itself, localhost and local tools keep working', async (context) => {
  const { port } = await startServer(context);
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const host = `${hostname}:${port}`;
    assert.equal((await send(port, { headers: { Host: host } })).status, 200, `read through ${hostname}`);
    const write = await send(port, {
      ...TERM_STATUS,
      headers: { Host: host, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' },
      body: termBody,
    });
    assert.equal(write.status, 200, `same-origin write through ${hostname}`);
  }
  // curl sends neither Origin nor Sec-Fetch-Site.
  const curl = await send(port, { ...TERM_STATUS, headers: { 'Content-Type': 'application/json' }, body: termBody });
  assert.equal(curl.status, 200);
  assert.equal((await send(port, { method: 'POST', pathname: '/api/jobs/archive-failed' })).status, 200, 'no body, no content type');
});

test('the guard refuses a malformed Host and a missing one', () => {
  const request = (host) => ({ method: 'GET', headers: { host } });
  assert.throws(() => guardRequest(request(undefined)), { statusCode: 403 });
  assert.throws(() => guardRequest(request('not a host')), { statusCode: 403 });
  assert.doesNotThrow(() => guardRequest(request('[::1]:4177')));
});

test('body limits apply per route, with 32 KB by default', async (context) => {
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readJson(request, request.url === '/large' ? { maxBytes: 128 * 1024 } : undefined);
      response.end(String(body.text.length));
    } catch (error) {
      response.statusCode = error.statusCode || 500;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const body = JSON.stringify({ text: 'x'.repeat(64 * 1024) });
  assert.equal((await send(port, { method: 'POST', pathname: '/small', body })).status, 413);
  assert.equal((await send(port, { method: 'POST', pathname: '/large', body })).status, 200);
});
