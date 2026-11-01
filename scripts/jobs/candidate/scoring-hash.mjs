import { createHash } from 'node:crypto';

import { withoutSection } from './document-sections.mjs';

function scoringText(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+$/gm, '').trim();
}

// What makes earlier scores out of date. Contact details and notes in comments
// are left out: fixing a phone number must not re-score anything.
export function canonicalScoringHash(profile, preferences) {
  return createHash('sha256')
    .update(scoringText(withoutSection(profile, 'Identity')))
    .update('\n--- preferences ---\n')
    .update(scoringText(preferences))
    .digest('hex');
}
