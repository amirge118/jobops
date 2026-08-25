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
    breakdown: { cvMatch: 5, seniority: 5, roleScope: 5, location: 5, sector: 4, uncertainties: ['אין ניסיון מפורש ב-Go; זו אינה דרישת חסימה.'] },
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

export function createDemoEnvironment({ rootDir, now = Date.now() }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-demo-'));
  const config = {
    rootDir,
    jobsDbPath: path.join(tempDir, 'jobs.db'),
    demo: true,
    scan: { defaultLookbackDays: 2, maxLookbackDays: 14 },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    sources: { whatsapp: { groups: GROUPS.map((name) => ({ name })) } },
    browser: { application: 'Google Chrome' },
  };
  const store = createJobStore(config.jobsDbPath);

  DEMO_JOBS.forEach((job, index) => {
    const sighting = store.recordSighting({
      url: `https://example.com/jobs/demo-${index + 1}`,
      company: job.company,
      title: job.title,
      source: index % 2 === 0 ? 'whatsapp' : 'ats',
      seenAt: now - index * 60 * 60 * 1000,
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
    sources: ['ats', 'whatsapp'],
    startedAt: now - 90_000,
  });
  store.finishRun(runId, {
    status: 'success',
    finishedAt: now - 30_000,
    details: {
      ats: { candidates: 8, companies: 12, found: 37, errors: 0, filtered: { title: 18, location: 7, recency: 4 } },
      whatsapp: {
        candidates: 5,
        messages: 21,
        warning: null,
        groups: GROUPS.map((name, index) => ({ name, found: true, messages: 4 + index, candidates: index === 0 ? 2 : 1, error: null })),
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
