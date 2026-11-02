import { createHash } from 'node:crypto';

import { requireOwner, resolveCurrentUser } from '../../jobs/current-user.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { applyUserSettings, saveUserSettings } from '../../jobs/user-settings.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

const SOURCE_TOGGLE = /^\/api\/sources\/(ats|whatsapp)\/enabled$/;

// The page never sees a group's WhatsApp address, only an id that means nothing elsewhere.
const groupId = (jid) => createHash('sha256').update(jid).digest('hex').slice(0, 16);

// Shared sources and how a person hears about matches. Sources run on the owner's
// accounts, so changing them is owner-only.
export function createSourceSettingsRoutes({ config, onSourcesChanged = () => {} }) {
  const withStore = async (callback) => {
    const store = createJobStore(config.jobsDbPath);
    try {
      return await callback(store);
    } finally {
      store.close();
    }
  };

  async function overview(store) {
    const user = resolveCurrentUser();
    const effective = await applyUserSettings(config, store, user.id);
    const selected = new Map((effective.sources?.whatsapp?.groups ?? []).filter(({ jid }) => jid).map(({ jid, name }) => [jid, name]));
    const known = await store.listKnownWhatsAppGroups();
    const seen = new Set(known.map(({ jid }) => jid));
    return {
      canEditSources: user.isOwner,
      enabled: {
        ats: Boolean(effective.sources?.ats?.enabled) && await store.isSourceEnabled('ats'),
        whatsapp: Boolean(effective.sources?.whatsapp?.enabled) && await store.isSourceEnabled('whatsapp'),
        linkedin: Boolean(effective.sources?.linkedin?.enabled) && await store.isSourceEnabled('linkedin'),
      },
      groups: [
        ...known.map(({ jid, name, participants }) => ({ id: groupId(jid), name, participants, selected: selected.has(jid) })),
        ...[...selected].filter(([jid]) => !seen.has(jid)).map(([jid, name]) => ({ id: groupId(jid), name, participants: null, selected: true })),
      ],
      linkedinSearches: effective.sources?.linkedin?.searches ?? [],
      notifications: { enabled: Boolean(effective.notifications?.whatsapp?.enabled), minScore: effective.notifications?.whatsapp?.minScore ?? null },
    };
  }

  return async (request, response, url) => {
    const { pathname } = url;
    if (pathname === '/api/sources' && request.method === 'GET') {
      sendJson(response, 200, await withStore(overview));
      return true;
    }
    if (request.method !== 'POST') return false;

    const toggle = pathname.match(SOURCE_TOGGLE);
    if (toggle) {
      requireOwner(resolveCurrentUser());
      const body = requireObjectBody(await readJson(request), ['enabled']);
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
      sendJson(response, 200, await withStore(async (store) => {
        await store.setSourceEnabled(toggle[1], body.enabled);
        return overview(store);
      }));
      return true;
    }
    if (pathname === '/api/sources/whatsapp/groups') {
      const user = resolveCurrentUser();
      requireOwner(user);
      const body = requireObjectBody(await readJson(request), ['ids']);
      if (!Array.isArray(body.ids)) throw Object.assign(new Error('ids must be a list'), { statusCode: 400 });
      const result = await withStore(async (store) => {
        const effective = await applyUserSettings(config, store, user.id);
        const candidates = [...await store.listKnownWhatsAppGroups(), ...(effective.sources?.whatsapp?.groups ?? []).filter(({ jid }) => jid)];
        const byId = new Map(candidates.map(({ jid, name }) => [groupId(jid), { jid, name }]));
        const groups = body.ids.map((id) => byId.get(id));
        if (groups.some((group) => !group)) throw Object.assign(new Error('קבוצה לא מוכרת'), { statusCode: 400 });
        await saveUserSettings(store, user.id, { 'sources.whatsapp.groups': groups }, config);
        return overview(store);
      });
      sendJson(response, 200, { ...result, restart: onSourcesChanged() ?? { restarted: false } });
      return true;
    }
    if (pathname === '/api/sources/linkedin/searches') {
      const user = resolveCurrentUser();
      requireOwner(user);
      const body = requireObjectBody(await readJson(request), ['searches']);
      sendJson(response, 200, await withStore(async (store) => {
        await saveUserSettings(store, user.id, { 'sources.linkedin.searches': body.searches }, config);
        return overview(store);
      }));
      return true;
    }
    if (pathname === '/api/sources/notifications') {
      const user = resolveCurrentUser();
      const body = requireObjectBody(await readJson(request), ['enabled', 'minScore']);
      sendJson(response, 200, await withStore(async (store) => {
        const values = { ...(body.enabled !== undefined ? { 'notifications.whatsapp.enabled': body.enabled } : {}), ...(body.minScore !== undefined ? { 'notifications.whatsapp.minScore': body.minScore } : {}) };
        await saveUserSettings(store, user.id, values, config);
        return overview(store);
      }));
      return true;
    }
    return false;
  };
}
