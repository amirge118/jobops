import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { openJobUrls } from '../scripts/jobs/open.mjs';

test('Chrome opener passes URLs as arguments without a shell', async () => {
  let invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };

  const result = await openJobUrls({
    jobs: [
      { jobKey: 'one', applyUrl: 'https://example.com/jobs/1' },
      { jobKey: 'bad', applyUrl: 'javascript:alert(1)' },
    ],
    application: 'Google Chrome',
    platform: 'darwin',
    spawnProcess,
  });

  assert.deepEqual(invocation, {
    command: '/usr/bin/open',
    args: ['-a', 'Google Chrome', 'https://example.com/jobs/1'],
    options: { stdio: 'ignore' },
  });
  assert.deepEqual(result, { opened: 1, jobKeys: ['one'] });
});
