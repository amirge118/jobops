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
export function checkCodexQuota({ store, now = Date.now() }) {
  const memory = inMemoryBlockedUntil(now);
  if (memory) return { available: false, until: memory, basis: 'memory' };
  const state = store.getLlmQuota();
  if (state.blockedUntil && state.blockedUntil > now) {
    noteUsageLimit(state.blockedUntil);
    return { available: false, until: state.blockedUntil, basis: 'stored' };
  }
  return { available: true, basis: state.lastSuccessAt ? 'recent_success' : 'unknown' };
}
