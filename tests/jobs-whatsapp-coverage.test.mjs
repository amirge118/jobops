import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCollectorCoverage, scanCollectedWhatsApp } from '../scripts/jobs/sources/whatsapp.mjs';

function connectedEvent(createdAt) {
  return { stage: 'connected', status: 'connected', createdAt };
}
function closedEvent(createdAt) {
  return { stage: 'connection-closed', status: 'warning', createdAt };
}

test('a window with no disconnects at all is fully covered', () => {
  const collector = { status: 'connected', events: [connectedEvent(0)] };
  const result = computeCollectorCoverage({ collector, sinceMs: 1_000, untilMs: 10_000 });
  assert.equal(result.covered, true);
  assert.equal(result.downtimeMs, 0);
});

test('a brief reconnect blip under the tolerance still counts as covered', () => {
  const collector = {
    status: 'connected',
    events: [connectedEvent(0), closedEvent(5_000), connectedEvent(5_500)],
  };
  const result = computeCollectorCoverage({ collector, sinceMs: 0, untilMs: 10_000, gapToleranceMs: 60_000 });
  assert.equal(result.covered, true);
  assert.equal(result.downtimeMs, 500);
});

test('a long disconnect exceeding the tolerance is reported as not covered', () => {
  const collector = {
    status: 'connected',
    events: [connectedEvent(0), closedEvent(5_000), connectedEvent(400_000)],
  };
  const result = computeCollectorCoverage({ collector, sinceMs: 0, untilMs: 500_000, gapToleranceMs: 60_000 });
  assert.equal(result.covered, false);
  assert.equal(result.downtimeMs, 395_000);
});

test('several short gaps that add up past the tolerance are not covered', () => {
  const collector = {
    status: 'connected',
    events: [
      connectedEvent(0),
      closedEvent(10_000), connectedEvent(40_000),
      closedEvent(60_000), connectedEvent(90_000),
    ],
  };
  const result = computeCollectorCoverage({ collector, sinceMs: 0, untilMs: 100_000, gapToleranceMs: 59_000 });
  assert.equal(result.covered, false);
  assert.equal(result.downtimeMs, 60_000);
});

test('still disconnected at the end of the window counts the open gap through untilMs', () => {
  const collector = { status: 'connected', events: [connectedEvent(0), closedEvent(5_000)] };
  const result = computeCollectorCoverage({ collector, sinceMs: 0, untilMs: 10_000, gapToleranceMs: 1_000 });
  assert.equal(result.covered, false);
  assert.equal(result.downtimeMs, 5_000);
});

test('downtime outside the requested window is not counted', () => {
  const collector = {
    status: 'connected',
    events: [connectedEvent(0), closedEvent(1_000), connectedEvent(1_500)],
  };
  // The window only starts after the blip has already ended.
  const result = computeCollectorCoverage({ collector, sinceMs: 2_000, untilMs: 10_000 });
  assert.equal(result.covered, true);
  assert.equal(result.downtimeMs, 0);
});

test('no event history, or a collector that is not currently connected, is never covered', () => {
  assert.equal(computeCollectorCoverage({ collector: null, sinceMs: 0, untilMs: 10_000 }).covered, false);
  assert.equal(computeCollectorCoverage({
    collector: { status: 'reconnecting', events: [connectedEvent(0)] }, sinceMs: 0, untilMs: 10_000,
  }).covered, false);
  assert.equal(computeCollectorCoverage({
    collector: { status: 'connected', events: [] }, sinceMs: 0, untilMs: 10_000,
  }).covered, false);
});

function fakeStore({ pending = [] } = {}) {
  return {
    getCheckpoint: () => 0,
    listPendingWhatsAppMessages: () => pending,
    recordSighting: ({ url, source, seenAt }) => ({ jobKey: url, canonicalUrl: url, source, seenAt }),
    markMessageDone() {},
    markMessageFailed() {},
    getMessageState: () => ({ status: 'done' }),
  };
}

test('scanCollectedWhatsApp reports complete coverage for a brief blip and marks reads accordingly', () => {
  const config = { sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'a@g.us' }], markRead: true } } };
  const collector = {
    id: 1,
    status: 'connected',
    last_message_at: 9_000,
    events: [connectedEvent(0), closedEvent(5_000), connectedEvent(5_200)],
  };

  const result = scanCollectedWhatsApp({ config, store: fakeStore(), sinceMs: 0, untilMs: 10_000, collector });

  assert.equal(result.groups[0].coverage.status, 'complete');
  assert.equal(result.groups[0].coverage.downtimeMs, 200);
});

test('scanCollectedWhatsApp still reports collector_gap for a genuinely long outage', () => {
  const config = { sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'a@g.us' }], markRead: true } } };
  const collector = {
    id: 1,
    status: 'connected',
    last_message_at: 9_000,
    events: [connectedEvent(0), closedEvent(5_000), connectedEvent(400_000)],
  };

  const result = scanCollectedWhatsApp({ config, store: fakeStore(), sinceMs: 0, untilMs: 500_000, collector });

  assert.equal(result.groups[0].coverage.status, 'partial');
  assert.equal(result.groups[0].coverage.reason, 'collector_gap');
  assert.equal(result.groups[0].coverage.downtimeMs, 395_000);
  assert.equal(result.groups[0].read.status, 'skipped');
});

test('a configured gapToleranceMs overrides the default', () => {
  const config = {
    sources: { whatsapp: { groups: [{ name: 'Group A', jid: 'a@g.us' }], markRead: true, collector: { gapToleranceMs: 100 } } },
  };
  const collector = {
    id: 1,
    status: 'connected',
    last_message_at: 9_000,
    events: [connectedEvent(0), closedEvent(5_000), connectedEvent(5_500)], // 500ms gap > 100ms tolerance
  };

  const result = scanCollectedWhatsApp({ config, store: fakeStore(), sinceMs: 0, untilMs: 10_000, collector });

  assert.equal(result.groups[0].coverage.status, 'partial');
});
