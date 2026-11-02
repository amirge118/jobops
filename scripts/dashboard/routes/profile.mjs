import { resolveCurrentUser } from '../../jobs/current-user.mjs';
import { decodeFile, extractCvFile, MAX_FILE_BYTES, organizedTextIsFaithful } from '../../jobs/candidate/cv-file.mjs';
import { createCvImporter } from '../../jobs/candidate/cv-import.mjs';
import { createCvInsights } from '../../jobs/candidate/cv-insights.mjs';
import { DOCUMENT_KINDS } from '../../jobs/candidate/file-sync.mjs';
import { createProfileService } from '../../jobs/candidate/profile-service.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;
const MAX_CV_TEXT_BODY_BYTES = 256 * 1024;
// Base64 is a third larger than the file, plus the rest of the request.
const MAX_FILE_BODY_BYTES = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096;
const UNORGANIZED_WARNING = 'לא הצלחנו לארגן את הטקסט בסעיפים, ולכן נשמר הטקסט כפי שנקרא מהקובץ.';
const KINDS = DOCUMENT_KINDS.join('|');
const DOCUMENT_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})$`);
const VERSIONS_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/versions$`);
const VERSION_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/versions/([1-9]\\d{0,8})$`);
const RESTORE_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/restore$`);
const ADOPT_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/adopt-file$`);

function failure(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function sendFile(response, file) {
  const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  response.writeHead(200, {
    'Content-Type': file.mimeType,
    'Content-Length': file.content.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(file.content);
}

// A person's CV, profile and preferences, always the current user's own.
export function createProfileRoutes({ config, draftCv = createCvImporter(config), cvInsights = createCvInsights(config) }) {
  let insightsRunning = false;

  // The file's own text is the fallback: a Codex outage must not block an
  // upload, and an organized copy that changed the words must not be saved.
  const organize = async (text) => {
    const unorganized = { markdown: `${text}\n`, identity: {}, warnings: [UNORGANIZED_WARNING] };
    try {
      const draft = await draftCv(text);
      return organizedTextIsFaithful(text, draft.markdown) ? draft : unorganized;
    } catch (error) {
      if (error.code === 'cv_import_busy') throw error;
      return unorganized;
    }
  };

  const withService = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try {
      return await callback(createProfileService({ store, config, userId: resolveCurrentUser().id }));
    } finally {
      store.close();
    }
  };
  const readBody = async (request, fields, maxBytes) => requireObjectBody(await readJson(request, { maxBytes }), fields);

  return async (request, response, url) => {
    const { pathname } = url;
    if (!pathname.startsWith('/api/profile')) return false;

    if (request.method === 'GET') {
      if (pathname === '/api/profile') {
        sendJson(response, 200, await withService((service) => service.overview()));
        return true;
      }
      if (pathname === '/api/profile/resume-file') {
        const file = await withService((service) => service.getResumeFile());
        if (file) sendFile(response, file);
        else sendJson(response, 404, { error: 'Not found' });
        return true;
      }
      if (pathname === '/api/profile/resume-insights') {
        sendJson(response, 200, await withService((service) => service.insights()));
        return true;
      }
      const versions = pathname.match(VERSIONS_ROUTE);
      if (versions) {
        sendJson(response, 200, { versions: await withService((service) => service.listVersions(versions[1])) });
        return true;
      }
      const version = pathname.match(VERSION_ROUTE);
      if (version) {
        const document = await withService((service) => service.getVersion(version[1], Number(version[2])));
        sendJson(response, document ? 200 : 404, document ? { document } : { error: 'Not found' });
        return true;
      }
      return false;
    }
    if (request.method !== 'POST') return false;

    const documentRoute = pathname.match(DOCUMENT_ROUTE);
    if (documentRoute) {
      const body = await readBody(request, ['content', 'baseVersion'], MAX_DOCUMENT_BODY_BYTES);
      sendJson(response, 200, await withService((service) => service.saveDocument(documentRoute[1], body.content, { baseVersion: body.baseVersion ?? null })));
      return true;
    }
    if (pathname === '/api/profile/identity') {
      const body = await readBody(request, ['fields', 'baseVersion']);
      sendJson(response, 200, await withService((service) => service.saveIdentity(body.fields, { baseVersion: body.baseVersion ?? null })));
      return true;
    }
    const restore = pathname.match(RESTORE_ROUTE);
    if (restore) {
      const body = await readBody(request, ['version', 'baseVersion']);
      sendJson(response, 200, await withService((service) => service.restoreVersion(restore[1], body.version, { baseVersion: body.baseVersion ?? null })));
      return true;
    }
    const adopt = pathname.match(ADOPT_ROUTE);
    if (adopt) {
      await readBody(request, []);
      sendJson(response, 200, await withService((service) => service.adoptFile(adopt[1])));
      return true;
    }
    if (pathname === '/api/profile/import-draft') {
      const body = await readBody(request, ['text'], MAX_CV_TEXT_BODY_BYTES);
      sendJson(response, 200, { draft: await draftCv(body.text) });
      return true;
    }
    if (pathname === '/api/profile/resume-file') {
      if (config.demo) throw failure(409, 'cv_file_unavailable', 'לא זמין במצב הדגמה');
      const body = await readBody(request, ['fileName', 'contentBase64', 'baseVersion'], MAX_FILE_BODY_BYTES);
      const baseVersion = body.baseVersion ?? null;
      await withService((service) => service.assertResumeVersion(baseVersion));
      const { text, ...file } = await extractCvFile(decodeFile(body.contentBase64), body.fileName);
      const draft = await organize(text);
      sendJson(response, 200, await withService((service) => service.saveResumeFile(file, draft, { baseVersion })));
      return true;
    }
    if (pathname === '/api/profile/resume-insights') {
      if (config.demo) throw failure(409, 'cv_insights_unavailable', 'לא זמין במצב הדגמה');
      await readBody(request, []);
      if (insightsRunning) throw failure(409, 'cv_insights_busy', 'ההסבר כבר נכתב. יש להמתין לסיומו.');
      insightsRunning = true;
      try {
        const { failed } = await withService((service) => service.generateInsights(cvInsights));
        sendJson(response, 200, { failed, ...await withService((service) => service.insights()) });
      } finally {
        insightsRunning = false;
      }
      return true;
    }
    if (pathname === '/api/profile/resume-facts/approve') {
      const body = await readBody(request, ['ids', 'baseVersion']);
      sendJson(response, 200, await withService((service) => service.approveFacts(body.ids, { baseVersion: body.baseVersion ?? null })));
      return true;
    }
    if (pathname === '/api/profile/resume-facts/dismiss') {
      const body = await readBody(request, ['ids']);
      await withService((service) => service.dismissFacts(body.ids));
      sendJson(response, 200, await withService((service) => service.insights()));
      return true;
    }
    return false;
  };
}
