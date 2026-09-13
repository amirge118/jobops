import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { fetchLimitedText } from '../scripts/providers/_http.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('bounded HTML transport rejects declared and streamed oversized responses', async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/declared') {
      response.writeHead(200, { 'content-length': '1000', 'content-type': 'text/html' });
      response.end('small');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('x'.repeat(200));
  });
  const baseUrl = await listen(server);
  context.after(() => close(server));

  await assert.rejects(
    fetchLimitedText(`${baseUrl}/declared`, { maxBytes: 100 }),
    /response exceeds 100 bytes/,
  );
  await assert.rejects(
    fetchLimitedText(`${baseUrl}/streamed`, { maxBytes: 100 }),
    /response exceeds 100 bytes/,
  );
});

test('bounded HTML transport keeps its timeout active while reading the body', async (context) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('partial');
  });
  const baseUrl = await listen(server);
  context.after(() => close(server));

  await assert.rejects(
    fetchLimitedText(baseUrl, { maxBytes: 100, timeoutMs: 20 }),
    (error) => error?.name === 'AbortError',
  );
});
