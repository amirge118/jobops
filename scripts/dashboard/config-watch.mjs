// The dashboard reads config/jobs.yml once at startup and hands it to every
// part of the server, so a changed group list or search stays invisible until
// a restart. Instead of reloading in place, the LaunchAgent copy exits once the
// new file parses and no action is running; launchd (KeepAlive with
// SuccessfulExit=false) starts it again with the new config. A config that
// fails to load keeps the current server up until the next change.

import fs from 'node:fs';

export const CONFIG_RESTART_EXIT_CODE = 75;

export function watchConfigForRestart({
  configPath, isBusy, validate, onRestart, log = console.log,
  intervalMs = 5_000, watch = fs.watchFile, unwatch = fs.unwatchFile,
  schedule = setTimeout, cancel = clearTimeout,
}) {
  let timer = null;

  function attempt() {
    timer = null;
    if (isBusy()) {
      timer = schedule(attempt, intervalMs);
      return;
    }
    try {
      validate();
    } catch (error) {
      log(`config/jobs.yml השתנה אבל לא נטען (${error.message}); הדשבורד ממשיך עם ההגדרות הקודמות.`);
      return;
    }
    onRestart();
  }

  const listener = (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs || timer) return;
    timer = schedule(attempt, 0);
  };
  watch(configPath, { interval: intervalMs }, listener);

  return () => {
    unwatch(configPath, listener);
    if (timer) cancel(timer);
  };
}
