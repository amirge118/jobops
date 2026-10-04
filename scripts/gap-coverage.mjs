#!/usr/bin/env node

// On-demand run of the check a scan does anyway: which personal-area gap terms
// the current resume already covers in other words. Useful right after
// editing profile/03-current-resume.md. Asks Codex only about unjudged terms.

import { loadJobsConfig, readCandidateContext } from './jobs/config.mjs';
import { createGapCoverageChecker, refreshGapCoverage } from './jobs/gap-coverage.mjs';
import { setCodexUsageRecorder } from './jobs/llm-usage.mjs';
import { createJobStore } from './jobs/store.mjs';

const config = loadJobsConfig();
const store = createJobStore(config.jobsDbPath);
setCodexUsageRecorder((entry) => store.recordCodexCall(entry));
try {
  const result = await refreshGapCoverage({
    store, checker: createGapCoverageChecker({ config }), candidateContext: readCandidateContext(config),
  });
  if (result.status === 'skipped') console.log('דולג: חסר profile/03-current-resume.md.');
  else if (!result.checked) console.log('אין נושאים חדשים לבדיקה מול קורות החיים הנוכחיים.');
  else console.log(`נבדקו ${result.checked} נושאים; ${result.covered} כבר מכוסים בקורות החיים ויוסרו מהאזור האישי.`);
} catch (error) {
  console.error(`בדיקת הכיסוי נכשלה: ${error.message}`);
  process.exitCode = 1;
} finally {
  setCodexUsageRecorder(null);
  store.close();
}
