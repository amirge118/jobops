export function startAdaptivePolling(task, {
  activeInterval = 2_500,
  idleInterval = 15_000,
  isActive = () => false,
} = {}) {
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = window.setTimeout(run, isActive() ? activeInterval : idleInterval);
  };

  const run = async () => {
    if (stopped) return;
    if (!document.hidden) await task();
    schedule();
  };

  const onVisibility = () => {
    if (document.hidden || stopped) return;
    window.clearTimeout(timer);
    run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  schedule();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
