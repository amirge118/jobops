import { resumeIsAvailable } from '../config.mjs';
import { applyUserSettings } from '../user-settings.mjs';
import { importMissingFromFiles } from './file-sync.mjs';

// Where a person stands, read from what they already did, so nothing here has to
// be kept up to date. A step can be skipped; it just stays open.
export async function onboardingState({ store, config, userId }) {
  await importMissingFromFiles({ store, config, userId });
  const effective = await applyUserSettings(config, store, userId);
  const stored = await store.listUserSettings(userId);
  const resume = await store.getCurrentDocument(userId, 'resume');
  const preferences = await store.getCurrentDocument(userId, 'preferences');
  const jobsSeen = await store.countJobs();
  const scanned = Boolean(await store.getLastRun());
  const hasSource = Boolean(effective.sources?.whatsapp?.groups?.length || effective.sources?.linkedin?.searches?.length || (await store.getCompanyStats()).watched);
  const steps = [
    { key: 'resume', done: Boolean(resume && resumeIsAvailable(resume.content)) },
    { key: 'search', done: Boolean(preferences || effective.search?.focusRole || effective.filters?.domains?.length) },
    // portals.yml ships with one profession's keywords, so having a list proves
    // nothing. Own keywords or a search already running on them does.
    { key: 'filters', done: Boolean(stored['search.titleFilter.positive']?.length || scanned) },
    { key: 'sources', done: hasSource },
    { key: 'scan', done: scanned },
  ];
  return { steps, complete: steps.every((step) => step.done), jobsSeen };
}
