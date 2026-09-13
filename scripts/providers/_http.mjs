// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; jobops/0.1)';

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = responseText;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

export async function fetchLimitedText(url, {
  maxBytes = 3_000_000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  method = 'GET',
  body = null,
  redirect = 'follow',
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) {
    throw new Error('maxBytes must be an integer between 1 and 10000000');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
  }
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
    fetchLimitedText,
  };
}
