import { CompanyRegistryError } from '../jobs/company-registry.mjs';

const MAX_BODY_BYTES = 32 * 1024;

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

// A route expecting larger documents passes its own maxBytes.
export async function readJson(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

export function requireObjectBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CompanyRegistryError('invalid_request', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    throw new CompanyRegistryError('invalid_request', 'Request body contains unsupported fields');
  }
  return body;
}

function companyErrorStatus(error) {
  if (!(error instanceof CompanyRegistryError)) return null;
  if (['company_not_found', 'job_not_found'].includes(error.code)) return 404;
  if (['source_conflict', 'job_not_suitable', 'company_not_resolved', 'company_not_scannable', 'approval_required', 'company_research_busy'].includes(error.code)) return 409;
  if (['company_research_timeout', 'company_research_login_required', 'company_research_failed'].includes(error.code)) return 503;
  return 400;
}

export function sendCompanyError(response, error) {
  const statusCode = companyErrorStatus(error);
  if (!statusCode) return false;
  sendJson(response, statusCode, { error: error.message, code: error.code });
  return true;
}
