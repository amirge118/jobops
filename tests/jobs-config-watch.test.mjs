import test from 'node:test';
import assert from 'node:assert/strict';

import { watchConfigForRestart } from '../scripts/dashboard/config-watch.mjs';

function harness({ busy = [false], validate = () => {} } = {}) {
  const calls = { restarts: 0, logs: [], validations: 0 };
  const queue = [];
  let listener = null;
  let busyIndex = 0;
  const stop = watchConfigForRestart({
    configPath: '/tmp/jobs.yml',
    isBusy: () => busy[Math.min(busyIndex++, busy.length - 1)],
    validate: () => { calls.validations += 1; validate(); },
    onRestart: () => { calls.restarts += 1; },
    log: (message) => calls.logs.push(message),
    watch: (_path, _options, fn) => { listener = fn; },
    unwatch: () => { listener = null; },
    schedule: (fn) => { queue.push(fn); return queue.length; },
    cancel: () => { queue.length = 0; },
  });
  return {
    calls, stop,
    change: (mtimeMs = 2, previous = 1) => listener?.({ mtimeMs }, { mtimeMs: previous }),
    flush: () => { while (queue.length) queue.shift()(); },
    pending: () => queue.length,
  };
}

test('a changed config restarts the dashboard once it loads', () => {
  const h = harness();
  h.change();
  h.flush();
  assert.equal(h.calls.validations, 1);
  assert.equal(h.calls.restarts, 1);
});

test('an unchanged mtime (a plain stat poll) does nothing', () => {
  const h = harness();
  h.change(5, 5);
  assert.equal(h.pending(), 0);
});

test('a running action defers the restart until it finishes', () => {
  const h = harness({ busy: [true, true, false] });
  h.change();
  h.flush();
  assert.equal(h.calls.restarts, 1);
  assert.equal(h.calls.validations, 1);
});

test('a config that fails to load keeps the current server', () => {
  const h = harness({ validate: () => { throw new Error('bad yaml'); } });
  h.change();
  h.flush();
  assert.equal(h.calls.restarts, 0);
  assert.match(h.calls.logs[0], /bad yaml/);
});

test('repeated changes while a restart is pending schedule it only once', () => {
  const h = harness();
  h.change(2, 1);
  h.change(3, 2);
  assert.equal(h.pending(), 1);
});

test('stopping removes the watcher and any pending attempt', () => {
  const h = harness();
  h.change();
  h.stop();
  assert.equal(h.pending(), 0);
  h.change();
  assert.equal(h.pending(), 0);
});
