import path from 'node:path';

import { WANTED_JOB_DECISIONS } from '../../jobs/decisions.mjs';
import { createJobStore, JOB_DECISIONS } from '../../jobs/store.mjs';
import { recordApplicationInTracker } from '../../jobs/tracker.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from '../../liveness-browser.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

// Decisions on jobs and archiving failures.
export function createJobsRoutes({ config, snapshot }) {
  return async (request, response, url) => {
    const decisionMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})\/decision$/)
      : null;
    if (decisionMatch) {
      const body = requireObjectBody(await readJson(request), ['decision']);
      if (!JOB_DECISIONS.has(body.decision)) {
        sendJson(response, 400, { error: 'סוג החלטה לא מוכר' });
        return true;
      }
      const store = createJobStore(config.jobsDbPath);
      let job;
      try {
        // Before archiving: the job must still be active to resolve its company,
        // and archiving wipes the details the tracker row needs.
        job = await store.getJob(decisionMatch[1]);
        if (WANTED_JOB_DECISIONS.has(body.decision)) await store.suggestCompanyForJob(decisionMatch[1]);
        if (!await store.decideJob(decisionMatch[1], body.decision)) {
          sendJson(response, 404, { error: 'המשרה לא נמצאה או שכבר הועברה לארכיון' });
          return true;
        }
      } finally {
        store.close();
      }
      // The decision is already saved; a tracker failure is reported, not fatal.
      let tracker = null;
      if (body.decision === 'applied') {
        try {
          // The demo shares the real rootDir; its tracker lives in the demo's temp dir.
          tracker = recordApplicationInTracker(config.demo ? path.dirname(config.jobsDbPath) : config.rootDir, {
            company: job.company, title: job.title, score: job.score, applyUrl: job.apply_url,
            date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' }),
          });
        } catch (error) {
          tracker = { action: 'failed', reason: String(error?.message || error).slice(0, 200) };
        }
      }
      sendJson(response, 200, { archived: true, decision: body.decision, tracker });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/jobs/archive-failed') {
      const store = createJobStore(config.jobsDbPath);
      let result;
      try {
        result = await store.archiveJobsByErrorCode([...NON_RETRYABLE_FAILURE_CODES]);
      } finally {
        store.close();
      }
      sendJson(response, 200, { ...result, state: await snapshot() });
      return true;
    }

    return false;
  };
}
