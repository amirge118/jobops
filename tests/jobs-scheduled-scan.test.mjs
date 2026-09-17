import test from 'node:test';
import assert from 'node:assert/strict';

import { renderScheduledScanAgent, SCHEDULES } from '../scripts/jobs/scheduled-scan-service.mjs';

test('the configured schedule matches WhatsApp 3x/day and one daily ATS run', () => {
  const ats = SCHEDULES.find((schedule) => schedule.key === 'ats');
  const whatsapp = SCHEDULES.find((schedule) => schedule.key === 'whatsapp');
  assert.deepEqual(ats.times, [{ hour: 14, minute: 0 }]);
  assert.deepEqual(ats.args, ['--ats-only']);
  assert.deepEqual(whatsapp.times, [{ hour: 10, minute: 0 }, { hour: 15, minute: 0 }, { hour: 20, minute: 0 }]);
  assert.deepEqual(whatsapp.args, ['--whatsapp-only']);
});

test('a scheduled scan agent fires jobs.mjs at every configured time, unattended', () => {
  const whatsapp = SCHEDULES.find((schedule) => schedule.key === 'whatsapp');
  const plist = renderScheduledScanAgent(whatsapp, { nodePath: '/opt/node', rootDir: '/tmp/jobops' });

  assert.match(plist, /<key>Label<\/key><string>com\.amirgefen\.jobops\.scan-whatsapp<\/string>/);
  assert.match(plist, /<string>\/opt\/node<\/string><string>\/tmp\/jobops\/scripts\/jobs\.mjs<\/string><string>--whatsapp-only<\/string>/);
  const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map((match) => Number(match[1]));
  assert.deepEqual(hours, [10, 15, 20]);
  // Not a persistent daemon: it should run once at each time and exit, never
  // relaunch on load or restart itself after finishing.
  assert.doesNotMatch(plist, /RunAtLoad/);
  assert.doesNotMatch(plist, /KeepAlive/);
});

test('the ATS agent has exactly one daily interval and its own distinct label', () => {
  const ats = SCHEDULES.find((schedule) => schedule.key === 'ats');
  const plist = renderScheduledScanAgent(ats, { nodePath: '/opt/node', rootDir: '/tmp/jobops' });

  assert.match(plist, /<key>Label<\/key><string>com\.amirgefen\.jobops\.scan-ats<\/string>/);
  assert.match(plist, /<string>--ats-only<\/string>/);
  const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map((match) => Number(match[1]));
  assert.deepEqual(hours, [14]);
});

test('scheduled agent XML-escapes an unusual node/project path', () => {
  const ats = SCHEDULES.find((schedule) => schedule.key === 'ats');
  const plist = renderScheduledScanAgent(ats, { nodePath: '/opt/node & tools/node', rootDir: '/tmp/jobops <local>' });
  assert.match(plist, /\/opt\/node &amp; tools\/node/);
  assert.match(plist, /\/tmp\/jobops &lt;local&gt;/);
});
