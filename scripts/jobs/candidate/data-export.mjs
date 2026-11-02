import { DOCUMENT_KINDS } from './file-sync.mjs';
import { parseIdentity } from './identity-section.mjs';

// Settings that describe shared sources, not the person. Group addresses in
// particular stay out of anything that leaves the app.
const NOT_PERSONAL_SETTINGS = new Set(['sources.whatsapp.groups', 'sources.linkedin.searches']);

// Everything the app holds about this person, in one file they can keep.
export async function exportPersonalData({ store, userId, now = Date.now() }) {
  const documents = {};
  for (const kind of DOCUMENT_KINDS) documents[kind] = (await store.getCurrentDocument(userId, kind))?.content ?? null;
  const settings = Object.fromEntries(Object.entries(await store.listUserSettings(userId)).filter(([key]) => !NOT_PERSONAL_SETTINGS.has(key)));
  const applications = (await store.listApplications(userId)).map(({ numberLabel, date, company, role, score, status, notes }) => ({ number: numberLabel, date, company, role, score, status, notes }));
  return {
    exportedAt: new Date(now).toISOString(),
    identity: parseIdentity(documents.profile ?? ''),
    documents,
    settings,
    applications,
    decisions: await store.listJobDecisions(),
    blockedCompanies: await store.listBlockedCompanies(),
    gapTermStatuses: await store.listGapTermStatuses(),
  };
}
