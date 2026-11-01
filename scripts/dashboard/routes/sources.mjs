import { createJobStore } from '../../jobs/store.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

// Source controls: the LinkedIn switch and WhatsApp history requests.
export function createSourcesRoutes({ config, queries }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/linkedin') {
      sendJson(response, 200, await queries.linkedin());
      return true;
    }

    // Searches themselves are defined only in config/jobs.yml; the dashboard
    // can only switch the whole source off or on. The switch changes what
    // the next scan requests, so it gets the non-simple-JSON CSRF guard.
    if (request.method === 'POST' && url.pathname === '/api/linkedin/enabled') {
      const body = requireObjectBody(await readJson(request), ['enabled']);
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
      sendJson(response, 200, await queries.setLinkedInEnabled(body.enabled));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/whatsapp/history') {
      const body = requireObjectBody(await readJson(request), ['days']);
      const days = body.days == null ? 30 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw Object.assign(new Error('days must be an integer between 1 and 365'), { statusCode: 400 });
      }
      const groupsTotal = config.sources.whatsapp?.groups?.length || 0;
      if (!groupsTotal) throw Object.assign(new Error('No WhatsApp groups are configured'), { statusCode: 409 });
      const toTs = Date.now();
      const store = createJobStore(config.jobsDbPath);
      try {
        const fromTs = toTs - days * 24 * 60 * 60 * 1_000;
        const groups = await Promise.all((config.sources.whatsapp?.groups || []).map(async (group) => {
          const lastCollectedAt = (await store.getWhatsAppGroupCollectionStats(group.jid)).lastCollectedAt;
          return {
            name: group.name,
            // Keep one second of overlap so the latest collected message can
            // be used as WhatsApp's exclusive history cursor. Deduplication
            // makes replaying that boundary message harmless.
            requestedFrom: Math.max(fromTs, Math.min((lastCollectedAt ?? fromTs) - 1_000, toTs - 1)),
          };
        }));
        const result = await store.requestWhatsAppHistory({
          fromTs,
          toTs,
          groupsTotal,
          groups,
        });
        sendJson(response, result.created ? 202 : 200, result);
      } finally { store.close(); }
      return true;
    }

    return false;
  };
}
