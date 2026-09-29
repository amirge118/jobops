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

test('LinkedIn runs three times a day off the WhatsApp slots and waits briefly for the scan lock', () => {
  const linkedin = SCHEDULES.find((schedule) => schedule.key === 'linkedin');
  assert.deepEqual(linkedin.args, ['--linkedin-only', '--wait-for-lock', '20']);
  assert.deepEqual(linkedin.times, [{ hour: 8, minute: 0 }, { hour: 12, minute: 30 }, { hour: 20, minute: 30 }]);
  const taken = new Set(SCHEDULES.filter((schedule) => schedule.key !== 'linkedin')
    .flatMap((schedule) => (schedule.times || []).map(({ hour, minute }) => `${hour}:${minute}`)));
  assert.equal(linkedin.times.some(({ hour, minute }) => taken.has(`${hour}:${minute}`)), false);
  const plist = renderScheduledScanAgent(linkedin, { nodePath: '/usr/bin/node', rootDir: '/project' });
  assert.match(plist, /<string>--linkedin-only<\/string><string>--wait-for-lock<\/string><string>20<\/string>/);
  assert.doesNotMatch(plist, /--open|RunAtLoad|KeepAlive/);
});

test('the WhatsApp trigger runs every 30 minutes as its own token-free script', () => {
  const trigger = SCHEDULES.find((schedule) => schedule.key === 'whatsapp-trigger');
  assert.equal(trigger.intervalSeconds, 1800);
  const plist = renderScheduledScanAgent(trigger, { nodePath: '/opt/node', rootDir: '/tmp/jobops' });
  assert.match(plist, /<string>\/tmp\/jobops\/scripts\/jobs\/whatsapp-trigger\.mjs<\/string><\/array>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>1800<\/integer>/);
  assert.doesNotMatch(plist, /StartCalendarInterval|RunAtLoad|KeepAlive/);
});
