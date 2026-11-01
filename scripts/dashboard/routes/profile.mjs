import { resolveCurrentUser } from '../../jobs/current-user.mjs';
import { createCvImporter } from '../../jobs/profile/cv-import.mjs';
import { DOCUMENT_KINDS } from '../../jobs/profile/file-sync.mjs';
import { createProfileService } from '../../jobs/profile/profile-service.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;
const MAX_CV_TEXT_BODY_BYTES = 256 * 1024;
const KINDS = DOCUMENT_KINDS.join('|');
const DOCUMENT_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})$`);
const VERSIONS_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/versions$`);
const VERSION_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/versions/([1-9]\\d{0,8})$`);
const RESTORE_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/restore$`);
const ADOPT_ROUTE = new RegExp(`^/api/profile/documents/(${KINDS})/adopt-file$`);

// A person's CV, profile and preferences, always the current user's own.
export function createProfileRoutes({ config, draftCv = createCvImporter(config) }) {
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
    return false;
  };
}
