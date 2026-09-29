// Codex (ChatGPT-login) usage: per-call token accounting and quota state.
//
// `codex exec --json` streams JSONL events; the final agent message carries
// the structured answer and `turn.completed` carries token usage. Every call
// is reported to a process-wide recorder (set by the CLI or dashboard) so
// usage can be stored per run and per purpose. When the account hits its
// usage limit, the reset time from Codex's message is kept in memory (so the
// rest of the run makes no further calls) and in SQLite (so later scheduled
// runs skip until it resets).

const USAGE_LIMIT_PATTERN = /usage limit|purchase more credits|hit your usage/i;

let recorder = null;
let blockedUntil = 0;

export function setCodexUsageRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

export function reportCodexCall(entry) {
  try { recorder?.(entry); } catch { /* accounting must never break scoring */ }
}

export function isUsageLimitMessage(message) {
  return USAGE_LIMIT_PATTERN.test(String(message ?? ''));
}

// "... try again at 1:43 PM." (local wall clock) or "... in 3 hours 20 minutes".
// Falls back to one hour when Codex gives no parseable time.
export function parseUsageLimitReset(message, now = Date.now()) {
  const text = String(message ?? '');
  const clock = text.match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const meridiem = (clock[3] || '').toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    const reset = new Date(now);
    reset.setHours(hour, Number(clock[2]), 0, 0);
    if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
    return reset.getTime();
  }
  const relative = text.match(/\bin\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)[\s,]*(?:and\s+)?)+)/i);
  if (relative) {
    const unitMinutes = { d: 24 * 60, h: 60, m: 1 };
    let minutes = 0;
    for (const [, count, unit] of relative[1].matchAll(/(\d+)\s*(day|hour|hr|minute|min)/gi)) {
      minutes += Number(count) * unitMinutes[unit[0].toLowerCase()];
    }
    if (minutes > 0) return now + minutes * 60_000;
  }
  return now + 60 * 60_000;
}

export function noteUsageLimit(until) {
  blockedUntil = Math.max(blockedUntil, Number(until) || 0);
}

export function inMemoryBlockedUntil(now = Date.now()) {
  return blockedUntil > now ? blockedUntil : 0;
}

export function resetInMemoryQuota() {
  blockedUntil = 0;
}

// Parses `codex exec --json` output. Plain JSON (older CLIs, test fakes) is
// accepted as the answer itself with unknown usage.
export function parseCodexJsonl(stdout) {
  const text = String(stdout ?? '').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && typeof event.type === 'string') events.push(event);
    } catch { /* not an event line */ }
  }
  if (!events.length) return { message: text || null, usage: null, error: null, events: false };

  let message = null;
  let usage = null;
  let error = null;
  for (const event of events) {
    const item = event.item || event.msg || null;
    if ((event.type === 'item.completed' || event.type === 'item.updated') && item &&
      (item.type === 'agent_message' || item.item_type === 'assistant_message') && typeof (item.text ?? item.message) === 'string') {
      message = item.text ?? item.message;
    }
    if (event.type === 'turn.completed' && event.usage) usage = normalizeUsage(event.usage);
    if (event.type === 'error' && event.message) error = String(event.message);
    if (event.type === 'turn.failed') error = String(event.error?.message || error || 'Codex turn failed');
  }
  return { message, usage, error, events: true };
}

function normalizeUsage(usage) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    inputTokens: number(usage.input_tokens),
    cachedInputTokens: number(usage.cached_input_tokens),
    outputTokens: number(usage.output_tokens),
    reasoningTokens: number(usage.reasoning_output_tokens ?? usage.reasoning_tokens),
  };
}

// Is there Codex quota right now? Only recorded evidence is used: a block
// set by a call that hit the usage limit (with Codex's reset time), until it
// resets. No test call is made: measured on 2026-09-29, even a one-word call
// costs ~14k input tokens (Codex's own agent instructions), while a call
// rejected for the limit costs nothing, so simply running is the cheapest
// check. The first rejection then stops the rest of that run.
export function checkCodexQuota({ store, now = Date.now(), readRateLimits = () => null }) {
  const memory = inMemoryBlockedUntil(now);
  if (memory) return { available: false, until: memory, basis: 'memory' };
  const state = store.getLlmQuota();
  if (state.blockedUntil && state.blockedUntil > now) {
    noteUsageLimit(state.blockedUntil);
    return { available: false, until: state.blockedUntil, basis: 'stored' };
  }
  // Free: Codex's own local record of the account's usage windows.
  let rateLimits = null;
  try { rateLimits = readRateLimits(); } catch { rateLimits = null; }
  const until = rateLimitBlockedUntil(rateLimits, now);
  if (until) {
    store.setLlmBlocked({ until, reason: 'usage_limit', at: now });
    noteUsageLimit(until);
    return { available: false, until, basis: 'codex_rate_limits', rateLimits };
  }
  return { available: true, basis: rateLimits ? 'codex_rate_limits' : state.lastSuccessAt ? 'recent_success' : 'unknown', rateLimits };
}

// ---- Free quota status from Codex's own session files ----------------------
// Every interactive Codex turn writes a `token_count` event with the account's
// rate-limit windows (5-hour "primary", weekly "secondary": used_percent and
// resets_at) to ~/.codex/sessions/**/rollout-*.jsonl. Reading the newest one
// costs nothing — no Codex call — and tells whether a run could score at all.
// Only the rate_limits object is read; conversation content is never parsed.

const TAIL_BYTES = 512 * 1024;
const RECENT_FILES = 8;

function listRolloutFiles(root, fsModule) {
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fsModule.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { files.push({ file: full, mtimeMs: fsModule.statSync(full).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECENT_FILES);
}

function lastRateLimitsIn(file, fsModule) {
  let text;
  try {
    const { size } = fsModule.statSync(file);
    const fd = fsModule.openSync(file, 'r');
    try {
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fsModule.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally { fsModule.closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"rate_limits"')) continue;
    try {
      const event = JSON.parse(lines[index]);
      const limits = event.payload?.rate_limits ?? event.rate_limits;
      if (limits) return { limits, observedAt: Date.parse(event.timestamp) || null };
    } catch { /* partial first line of the tail */ }
  }
  return null;
}

function normalizeWindow(window) {
  if (!window || !Number.isFinite(Number(window.used_percent))) return null;
  return {
    usedPercent: Number(window.used_percent),
    windowMinutes: Number(window.window_minutes) || null,
    resetsAt: Number(window.resets_at) ? Number(window.resets_at) * 1000 : null,
  };
}

export function readCodexRateLimits({ codexHome = `${process.env.HOME}/.codex`, fsModule } = {}) {
  const files = listRolloutFiles(`${codexHome}/sessions`, fsModule);
  let newest = null;
  for (const { file } of files) {
    const found = lastRateLimitsIn(file, fsModule);
    if (found && (!newest || (found.observedAt || 0) > (newest.observedAt || 0))) newest = found;
  }
  if (!newest) return null;
  return {
    observedAt: newest.observedAt,
    primary: normalizeWindow(newest.limits.primary),
    secondary: normalizeWindow(newest.limits.secondary),
    planType: newest.limits.plan_type || null,
    reachedType: newest.limits.rate_limit_reached_type || null,
  };
}

// The earliest moment the account can run again, or null when it can run now.
export function rateLimitBlockedUntil(rateLimits, now = Date.now()) {
  if (!rateLimits) return null;
  const exhausted = [rateLimits.primary, rateLimits.secondary]
    .filter((window) => window && window.usedPercent >= 100 && window.resetsAt && window.resetsAt > now);
  if (!exhausted.length) return null;
  return Math.max(...exhausted.map((window) => window.resetsAt));
}
