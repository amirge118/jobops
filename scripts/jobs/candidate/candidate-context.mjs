import { resumeHashOf, resumeIsAvailable } from '../config.mjs';
import { driftedKinds, importMissingFromFiles } from './file-sync.mjs';
import { applyUserSettings } from '../user-settings.mjs';
import { canonicalScoringHash, scoringCriteria } from './scoring-hash.mjs';

// The candidate text a scan or a page works from, for one user.
export async function loadCandidateContext({ store, config, userId }) {
  await importMissingFromFiles({ store, config, userId });
  const [profile, preferences, resume] = await Promise.all(['profile', 'preferences', 'resume']
    .map((kind) => store.getCurrentDocument(userId, kind)));
  if (!profile) throw new Error('Missing candidate profile');
  const effective = await applyUserSettings(config, store, userId);
  // The form on the page is enough; free text about the search is optional.
  if (!preferences && !effective.search?.focusRole && !effective.filters?.domains?.length) throw new Error('Missing candidate preferences');
  const preferencesText = preferences?.content ?? '';
  const canonicalHash = canonicalScoringHash(profile.content, preferencesText, scoringCriteria(effective));
  const currentResume = resume?.content ?? '';
  return {
    profile: profile.content,
    preferences: preferencesText,
    profileHash: await store.getScoringHashAlias(userId, canonicalHash) ?? canonicalHash,
    currentResume,
    resumeHash: resumeHashOf(currentResume),
    resumeAvailable: resumeIsAvailable(currentResume),
    fileDrift: await driftedKinds({ store, config, userId }),
  };
}
