import { spawnSync } from 'node:child_process';

import { COLLECTOR_LABEL } from '../jobs/collector-service.mjs';
import { CONFIG_RESTART_EXIT_CODE } from './config-watch.mjs';

// Which groups are collected is read when a process starts, so both the collector
// and the dashboard start over. A running action finishes first; the dashboard
// picks the change up when it next starts, and the collector needs no wait.
export function applySourceChange({ managed, isBusy, exit = process.exit, run = spawnSync, schedule = setTimeout }) {
  if (!managed) {
    console.log('מקורות השתנו; הפעל מחדש את הדשבורד וה-collector כדי לטעון אותם.');
    return { restarted: false };
  }
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${COLLECTOR_LABEL}`], { stdio: 'ignore' });
  if (!isBusy()) schedule(() => exit(CONFIG_RESTART_EXIT_CODE), 200);
  return { restarted: true };
}
