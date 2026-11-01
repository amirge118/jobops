// The dashboard listens only on loopback, but a website open in the same browser
// can still reach it: by POSTing cross-origin, or by pointing its own domain at
// 127.0.0.1 (DNS rebinding) to also read the responses. Every request passes here.

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WRITE_METHODS_EXEMPT = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin', 'none']);

function refuse(code, message, statusCode = 403) {
  return Object.assign(new Error(message), { statusCode, code });
}

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function hasBody(request) {
  return Number(request.headers['content-length'] || 0) > 0 || Boolean(request.headers['transfer-encoding']);
}

export function guardRequest(request) {
  const { host, origin } = request.headers;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) throw refuse('foreign_host', 'Request host is not allowed');
  if (WRITE_METHODS_EXEMPT.has(request.method)) return;

  // Browsers send Origin on every cross-origin write. Local tools such as curl
  // send neither header, and they already run as this user.
  if (origin !== undefined) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* "null" and malformed origins are refused below. */ }
    if (originHost !== host) throw refuse('foreign_origin', 'Request origin is not allowed');
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && !SAME_ORIGIN_FETCH_SITES.has(fetchSite)) {
    throw refuse('foreign_origin', 'Request origin is not allowed');
  }

  // A JSON body can't be sent cross-origin without a preflight, which this server never approves.
  if (hasBody(request)) {
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw refuse('unsupported_media_type', 'Content-Type must be application/json', 415);
  }
}
