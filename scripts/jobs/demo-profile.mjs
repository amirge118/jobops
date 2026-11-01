import { LOCAL_USER_ID } from './current-user.mjs';
import { canonicalScoringHash, scoringCriteria } from './candidate/scoring-hash.mjs';

const RESUME = `# Noa Example

## Work Experience
Backend engineer at Northstar Labs, building event pipelines and public APIs.

## Technical Skills
Python, Node.js, PostgreSQL, Kafka, AWS.
`;
const PROFILE = `# Candidate Profile

## Identity
- **Name:** Noa Example
- **Location:** Tel Aviv
- **Email:** noa@example.com

## Professional Summary
Backend engineer with six years of experience in event-driven systems.

## Professional Experience
Northstar Labs, Backend Engineer, 2020 to today.
`;
const PREFERENCES = `# Preferences

## Target Roles
Backend or platform engineering.

## Deal-breakers
Full-time on-site outside the center of the country.
`;

// Synthetic only. The demo shares the real project folder but never its documents.
export async function seedDemoProfile(store, config, profileHash) {
  await store.importMissingDocuments(LOCAL_USER_ID, [
    { kind: 'profile', content: PROFILE },
    { kind: 'preferences', content: PREFERENCES },
    { kind: 'resume', content: RESUME },
  ], { alias: { canonicalHash: canonicalScoringHash(PROFILE, PREFERENCES, scoringCriteria(config)), storedHash: profileHash } });
}
