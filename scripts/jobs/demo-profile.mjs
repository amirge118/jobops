import { LOCAL_USER_ID } from './current-user.mjs';
import { CV_ANALYSIS_VERSION, CV_FACTS_VERSION } from './candidate/cv-insights.mjs';
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
  await seedDemoFile(store);
}

// The demo never calls AI, so what the CV page explains is written here.
async function seedDemoFile(store) {
  const { contentHash } = await store.getCurrentDocument(LOCAL_USER_ID, 'resume');
  const content = Buffer.from('%PDF-1.4\n% Synthetic demo file\n');
  await store.saveProfileFile(LOCAL_USER_ID, {
    fileName: 'noa-example-cv.pdf', mimeType: 'application/pdf', sha256: 'demo', sizeBytes: content.length, content, textHash: contentHash,
    identity: { name: 'Noa Example' },
  });
  await store.saveCvInsight(LOCAL_USER_ID, 'analysis', contentHash, CV_ANALYSIS_VERSION, {
    headline: 'מפתחת Backend עם ניסיון במערכות מבוססות אירועים',
    summary: 'קורות החיים מציגים מפתחת צד שרת ב-Northstar Labs שבונה צינורות אירועים וממשקי API ציבוריים. הדגש הוא על הכלים, ופחות על התוצאות שהעבודה השיגה.',
    strengths: ['Event pipelines', 'Public APIs', 'Kafka'],
    targetRoles: ['Backend Engineer', 'Platform Engineer'],
    improvements: [{
      title: 'התיאור לא מספר מה יצא מהעבודה',
      why: 'מגייסים מחפשים תוצאה. כדאי לבדוק אם יש לך נתון אמיתי על היקף או שיפור שאפשר לציין.',
      quote: 'Backend engineer at Northstar Labs, building event pipelines and public APIs.',
    }],
  });
  await store.saveCvInsight(LOCAL_USER_ID, 'facts', contentHash, CV_FACTS_VERSION, {
    items: [
      { id: 'demo-skills', kind: 'new', quote: 'Python, Node.js, PostgreSQL, Kafka, AWS.', section: 'Professional Experience', note: '' },
      { id: 'demo-conflict', kind: 'conflict', quote: 'Backend engineer at Northstar Labs', section: 'Professional Experience', note: 'בקורות החיים אין תאריכים לתפקיד, ובעובדות כתוב 2020 עד היום.' },
    ],
    dismissed: [],
  });
}
