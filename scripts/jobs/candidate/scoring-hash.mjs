import { createHash } from 'node:crypto';

import { withoutSection } from './document-sections.mjs';

function scoringText(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+$/gm, '').trim();
}

// What makes earlier scores out of date. Contact details and notes in comments
// are left out: fixing a phone number must not re-score anything. Criteria are
// the structured settings the prompt is built from.
export function canonicalScoringHash(profile, preferences, criteria = {}) {
  return createHash('sha256')
    .update(scoringText(withoutSection(profile, 'Identity')))
    .update('\n--- preferences ---\n')
    .update(scoringText(preferences))
    .update('\n--- criteria ---\n')
    .update(JSON.stringify(criteria))
    .digest('hex');
}

// The settings that change what the scorer is told, in a fixed order.
export function scoringCriteria(config) {
  const { domains = [], acceptedLocations = [], preferredSectors = [] } = config.filters ?? {};
  const { rolePreset = null, focusRole = null, excludedRoleTypes = [], maxLevel = null, levelCapTitles = [], avoidPeopleManagement = false, homeCountry = null } = config.search ?? {};
  return { domains, acceptedLocations, preferredSectors, rolePreset, focusRole, excludedRoleTypes, maxLevel, levelCapTitles, avoidPeopleManagement, homeCountry };
}
