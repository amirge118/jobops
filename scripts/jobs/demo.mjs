import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobStore } from './store.mjs';

const GROUPS = [
  'Backend Israel',
  'Tech Jobs IL',
  'Data & Platform Roles',
  'Startup Opportunities',
];

const DEMO_JOBS = [
  {
    company: 'Northstar Labs',
    title: 'Senior Backend Engineer',
    summary: 'פיתוח שירותי Backend מבוזרים, תשתיות אירועים ו-APIs למוצר B2B.',
    score: 4.8,
    fitLabel: 'בול מתאים',
    decisionReason: 'התאמה חזקה לניסיון Backend, מערכות מבוזרות ו-Node.js ברמת seniority מתאימה.',
    breakdown: {
      cvMatch: 5, seniority: 5, roleScope: 5, location: 5, sector: 4,
      evidence: {
        cvMatch: 'נדרשים Node.js ומערכות מבוזרות בפרודקשן; שניהם מופיעים בפרופיל.',
        seniority: 'נדרשות 4–7 שנות ניסיון; הפרופיל בטווח.',
        roleScope: 'פיתוח שירותי Backend ו-APIs הוא עיקר התפקיד.',
        location: 'תל אביב, מודל היברידי.',
        sector: 'SaaS B2B — תחום ניטרלי-חיובי, לא מהמועדפים.',
      },
      uncertainties: ['אין ניסיון מפורש ב-Go; זו אינה דרישת חסימה.'],
    },
  },
  {
    company: 'Harbor Data',
    title: 'Backend & Data Platform Engineer',
    summary: 'בניית pipelines, שירותי ingestion ותשתית נתונים בענן.',
    score: 4.6,
    fitLabel: 'בול מתאים',
    decisionReason: 'התפקיד משלב Backend ו-Data Platform ומתאים לניסיון ב-SQL, AWS ותהליכי נתונים.',
    breakdown: { cvMatch: 5, seniority: 4, roleScope: 5, location: 5, sector: 4, uncertainties: [] },
  },
  {
    company: 'Cedar Security',
    title: 'Backend Engineer',
    summary: 'פיתוח APIs ושירותי אבטחה למערכת SaaS בקנה מידה גבוה.',
    score: 4.3,
    fitLabel: 'מתאים',
    decisionReason: 'ניסיון Backend רלוונטי ומיקום מתאים; תחום הסייבר חדש יחסית לפרופיל.',
    breakdown: { cvMatch: 4, seniority: 4, roleScope: 5, location: 5, sector: 3, uncertainties: ['לא ברור כמה מהתפקיד כולל on-call.'] },
  },
  {
    company: 'Orbit Fintech',
    title: 'Platform Engineer',
    summary: 'שיפור תשתיות פיתוח, observability ואמינות שירותי production.',
    score: 4.1,
    fitLabel: 'מתאים',
    decisionReason: 'התאמה טובה לתשתיות Backend ואמינות, עם מעבר מתון לכיוון Platform.',
    breakdown: { cvMatch: 4, seniority: 4, roleScope: 4, location: 5, sector: 5, uncertainties: ['חלוקת הזמן בין פיתוח מוצר ל-DevOps אינה מפורטת.'] },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_DECISIONS = [
  { company: 'Lumen Pay', title: 'Backend Engineer', score: 4.4, decision: 'interested', daysAgo: 1, source: 'WhatsApp: Backend Israel', fit: { cvMatch: 4, seniority: 5, roleScope: 5, location: 5, sector: 5 } },
  { company: 'Quarry AI', title: 'Staff Backend Engineer', score: 4.2, decision: 'too_senior', daysAgo: 2, source: 'ATS: demo', fit: { cvMatch: 4, seniority: 4, roleScope: 5, location: 5, sector: 5 } },
  { company: 'Mosaic', title: 'Data Engineer', score: 3.8, decision: 'interested', daysAgo: 3, source: 'LinkedIn: Backend', fit: { cvMatch: 3, seniority: 4, roleScope: 4, location: 5, sector: 3 } },
  { company: 'Bigcorp', title: 'Backend Developer', score: 4.1, decision: 'company_not_interesting', daysAgo: 5, source: 'ATS: demo', fit: { cvMatch: 4, seniority: 4, roleScope: 4, location: 4, sector: 3 } },
  { company: 'Relay Systems', title: 'Integration Engineer', score: 3.7, decision: 'not_relevant', daysAgo: 9, source: 'WhatsApp: Tech Jobs IL', fit: { cvMatch: 3, seniority: 4, roleScope: 4, location: 5, sector: 3 } },
  { company: 'Northwind Bank', title: 'Senior Backend Engineer', score: 4.7, decision: 'company_candidate', daysAgo: 12, source: 'ATS: demo', fit: { cvMatch: 5, seniority: 5, roleScope: 5, location: 4, sector: 5 } },
];

export function createDemoEnvironment({ rootDir, now = Date.now() }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-demo-'));
  const config = {
    rootDir,
    jobsDbPath: path.join(tempDir, 'jobs.db'),
    demo: true,
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: {
      whatsapp: { groups: GROUPS.map((name) => ({ name })) },
      linkedin: {
        enabled: true,
        searches: [
          { key: 'backend', label: 'Backend', keywords: 'backend OR "server side"', location: 'Israel' },
          { key: 'data-analyst', label: 'Data Analyst', keywords: '"data analyst"', location: 'Israel' },
        ],
      },
    },
    browser: { application: 'Google Chrome' },
  };
  const store = createJobStore(config.jobsDbPath);
  store.syncLinkedInSearches(config.sources.linkedin.searches, now);
  const [backendSearch, analystSearch] = store.listLinkedInSearches();
  const backendSummary = {
    status: 'complete', reason: null, endedBy: 'end_of_results', capped: false, pages: 2,
    window: { from: now - 5 * 60 * 60 * 1000, to: now - 60_000, basis: 'progress', mode: 'auto' },
    found: 14, new: 3, known: 10, filtered: 1,
  };
  store.recordLinkedInSearchAttempt({ searchId: backendSearch.id, queryHash: backendSearch.queryHash, status: 'complete',
    summary: backendSummary, coveredUntil: now - 60_000, attemptedAt: now - 60_000 });
  const analystSummary = { ...backendSummary, endedBy: 'no_matches_fallback', pages: 0, found: 0, new: 0, known: 0, filtered: 0 };
  store.recordLinkedInSearchAttempt({ searchId: analystSearch.id, queryHash: analystSearch.queryHash, status: 'complete',
    summary: analystSummary, coveredUntil: now - 60_000, attemptedAt: now - 60_000 });

  DEMO_JOBS.forEach((job, index) => {
    const linkedin = index === 1;
    const sighting = store.recordSighting({
      // Synthetic URL even for the LinkedIn-sourced row: demo data never points at a real posting.
      url: `https://example.com/jobs/demo-${index + 1}`,
      company: job.company,
      title: job.title,
      source: linkedin ? 'LinkedIn: Backend' : index % 2 === 0 ? `WhatsApp: ${GROUPS[0]}` : 'ATS: demo',
      seenAt: now - index * 60 * 60 * 1000,
      matchCompanyRole: !linkedin,
    });
    store.saveEvaluation(sighting.jobKey, {
      company: job.company,
      title: job.title,
      summary: job.summary,
      score: job.score,
      fitLabel: job.fitLabel,
      decisionReason: job.decisionReason,
      fitBreakdown: job.breakdown,
      suitable: true,
      applyUrl: sighting.canonicalUrl,
      activeStatus: 'active',
      contentHash: `demo-content-${index}`,
      profileHash: 'demo-profile',
      criteriaVersion: 'demo-v1',
      evaluatedAt: now - index * 60 * 60 * 1000,
    });
  });

  // Past decisions, so the statistics page has something to show.
  DEMO_DECISIONS.forEach((item, index) => {
    const url = `https://example.com/jobs/demo-decided-${index + 1}`;
    const sighting = store.recordSighting({
      url, company: item.company, title: item.title, source: item.source, seenAt: now - item.daysAgo * DAY_MS,
    });
    store.saveEvaluation(sighting.jobKey, {
      company: item.company, title: item.title, summary: '', score: item.score, fitLabel: 'מתאים',
      decisionReason: '', fitBreakdown: item.fit, suitable: true, applyUrl: url, activeStatus: 'active',
      contentHash: `demo-decided-${index}`, profileHash: 'demo-profile', criteriaVersion: 'demo-v1',
      evaluatedAt: now - item.daysAgo * DAY_MS,
    });
    store.decideJob(sighting.jobKey, item.decision, now - item.daysAgo * DAY_MS + 60_000);
  });

  const rejected = store.recordSighting({
    url: 'https://example.com/jobs/demo-frontend',
    company: 'Canvas Studio',
    title: 'Frontend Engineer',
    source: 'whatsapp',
    seenAt: now - 5 * 60 * 60 * 1000,
  });
  store.saveEvaluation(rejected.jobKey, {
    company: 'Canvas Studio', title: 'Frontend Engineer', summary: 'פיתוח ממשקי Web.',
    score: 2.7, fitLabel: 'לא מתאים', decisionReason: 'התפקיד מחוץ לתחומי המטרה.',
    fitBreakdown: null, suitable: false, applyUrl: rejected.canonicalUrl,
    activeStatus: 'active', contentHash: 'demo-rejected', profileHash: 'demo-profile',
    criteriaVersion: 'demo-v1', evaluatedAt: now - 5 * 60 * 60 * 1000,
  });

  const runId = store.startRun({
    fromTs: now - 24 * 60 * 60 * 1000,
    toTs: now,
    sources: ['ats', 'whatsapp', 'linkedin'],
    startedAt: now - 90_000,
  });
  store.finishRun(runId, {
    status: 'success',
    finishedAt: now - 30_000,
    details: {
      linkedin: {
        candidates: 3, requests: 3, haltedBy: null, failure: null, coverageStatus: 'complete',
        discovery: { found: 14, new: 3, known: 10 },
        searches: [
          { id: backendSearch.id, label: 'Backend', ...backendSummary, warning: null, gap: null, advanced: true },
          { id: analystSearch.id, label: 'Data Analyst', ...analystSummary, warning: null, gap: null, advanced: true },
        ],
      },
      ats: { candidates: 8, companies: 12, found: 37, errors: 0, filtered: { title: 18, location: 7, recency: 4 } },
      whatsapp: {
        candidates: 5,
        messages: 21,
        coverageStatus: 'complete',
        warning: null,
        groups: GROUPS.map((name, index) => ({
          name,
          found: true,
          messages: 4 + index,
          candidates: index === 0 ? 2 : 1,
          coverage: {
            status: 'complete',
            requestedFrom: now - 24 * 60 * 60 * 1000,
            oldestAt: now - 24 * 60 * 60 * 1000,
            newestAt: now - 60 * 60 * 1000,
            delivered: 4 + index,
          },
          error: null,
        })),
      },
      processing: {
        totals: { links: 13, processed: 11, suitable: 4, notSuitable: 7, failed: 0, alreadyProcessed: 2 },
        scopes: [
          { source: 'ats', name: 'ATS', links: 8, processed: 7, suitable: 2, notSuitable: 5, failed: 0, alreadyProcessed: 1 },
          { source: 'linkedin', name: 'Backend', links: 3, processed: 3, suitable: 1, notSuitable: 2, failed: 0, alreadyProcessed: 0 },
          { source: 'whatsapp', name: GROUPS[0], links: 2, processed: 2, suitable: 1, notSuitable: 1, failed: 0, alreadyProcessed: 0 },
          { source: 'whatsapp', name: GROUPS[1], links: 1, processed: 1, suitable: 1, notSuitable: 0, failed: 0, alreadyProcessed: 0 },
          { source: 'whatsapp', name: GROUPS[2], links: 1, processed: 1, suitable: 0, notSuitable: 1, failed: 0, alreadyProcessed: 0 },
          { source: 'whatsapp', name: GROUPS[3], links: 1, processed: 0, suitable: 0, notSuitable: 0, failed: 0, alreadyProcessed: 1 },
        ],
      },
    },
  });

  return {
    config,
    store,
    cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

export function runDemoAction(_command, _rootDir, onOutput) {
  onOutput('מצב הדגמה: הפעולה הושלמה עם נתונים סינתטיים בלבד.\n');
  return Promise.resolve();
}
