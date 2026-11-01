import fs from 'node:fs';
import path from 'node:path';

import { resumeHashOf } from '../../jobs/config.mjs';
import { coverageKeyOf } from '../../jobs/gap-coverage.mjs';
import { aggregateGaps } from '../../jobs/gap-insights.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

// The personal area: resume gaps and their statuses.
export function createPersonalAreaRoutes({ config }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/personal-area/insights') {
      const resumePath = path.join(config.rootDir, 'profile', '03-current-resume.md');
      const currentResumeText = fs.existsSync(resumePath) ? fs.readFileSync(resumePath, 'utf8') : '';
      const store = createJobStore(config.jobsDbPath);
      try {
        const judged = await store.listGapTermCoverage(coverageKeyOf(resumeHashOf(currentResumeText)));
        sendJson(response, 200, aggregateGaps(await store.listGapObservations(), {
          currentResumeText, statuses: await store.listGapTermStatuses(),
          coveredTerms: new Set([...judged].filter(([, covered]) => covered).map(([key]) => key)),
        }));
      }
      finally { store.close(); }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/personal-area/term-status') {
      const body = requireObjectBody(await readJson(request), ['term', 'status']);
      const store = createJobStore(config.jobsDbPath);
      try { sendJson(response, 200, { status: await store.setGapTermStatus(body.term, body.status ?? null) }); }
      finally { store.close(); }
      return true;
    }

    return false;
  };
}
