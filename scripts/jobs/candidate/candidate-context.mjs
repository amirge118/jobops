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
  if (!preferences) throw new Error('Missing candidate preferences');
  const effective = await applyUserSettings(config, store, userId);
  const canonicalHash = canonicalScoringHash(profile.content, preferences.content, scoringCriteria(effective));
  const currentResume = resume?.content ?? '';
  return {
    profile: profile.content,
    preferences: preferences.content,
    profileHash: await store.getScoringHashAlias(userId, canonicalHash) ?? canonicalHash,
    currentResume,
    resumeHash: resumeHashOf(currentResume),
    resumeAvailable: resumeIsAvailable(currentResume),
    fileDrift: await driftedKinds({ store, config, userId }),
  };
}
