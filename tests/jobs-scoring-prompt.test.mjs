import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildScoringPrompt } from '../scripts/jobs/candidate/scoring-prompt.mjs';

const CONTEXT = { profile: '# Candidate Profile\n<!-- note -->\n\n## Summary\nBackend engineer.\n', preferences: '# Preferences\n\n## Target Roles\nBackend\n' };
const FILTERS = { domains: ['Backend', 'AI Engineering'], acceptedLocations: ['Tel Aviv', 'Ramat Gan'], preferredSectors: ['Fintech'] };
const CALIBRATED = {
  rolePreset: 'backend',
  excludedRoleTypes: ['Data engineering', 'data analysis', 'BI'],
  maxLevel: 'Senior',
  levelCapTitles: ['Lead', 'Tech Lead', 'Team Lead', 'Staff', 'Principal', 'Architect', 'Head', 'Director', 'CTO'],
  avoidPeopleManagement: true,
  homeCountry: 'Israel',
};

test('the settings of the calibrated search rebuild the frozen prompt, so its scoring does not move', () => {
  const golden = fs.readFileSync(new URL('./fixtures/scoring-prompt-golden.txt', import.meta.url), 'utf8').trimEnd();
  // The one deliberate wording change: a country name works for every user.
  const expected = golden.replace('an Israeli posting', 'a posting in Israel').replace('in Israel outside', 'in Israel outside');
  assert.equal(buildScoringPrompt({ filters: FILTERS, search: CALIBRATED }, CONTEXT), expected);
});

test('a user with other settings gets none of the calibrated assumptions', () => {
  const prompt = buildScoringPrompt({
    filters: { domains: ['Product Design'], acceptedLocations: ['Berlin'], preferredSectors: [] },
    search: { rolePreset: 'generic', focusRole: 'Product Designer', homeCountry: 'Germany' },
  }, { profile: 'Designer', preferences: 'Design roles' });
  for (const assumption of [/backend/i, /Israel/, /Senior per/, /people management/, /BI roles/]) {
    assert.doesNotMatch(prompt.split('Decision rules:')[1], assumption);
  }
  assert.match(prompt, /Product Designer is the main work/);
  assert.match(prompt, /a posting in Germany/);
  assert.match(prompt, /A role that is mainly something other than Product Designer/);
});

test('with nothing set, the rules stay valid and neutral', () => {
  const prompt = buildScoringPrompt({}, { profile: 'x', preferences: 'y' });
  assert.match(prompt, /the target role is the main work/);
  assert.match(prompt, /in the candidate's country outside/);
  assert.doesNotMatch(prompt, /undefined|null|\[object/);
});

test('contact details and comments never reach the AI, other identity lines do', () => {
  const prompt = buildScoringPrompt({ search: CALIBRATED, filters: FILTERS }, {
    profile: '## Identity\n- **Name:** Noa\n- **Location:** Tel Aviv\n- **Phone:** 050-1\n- **Email:** n@x.io\n- **LinkedIn:** li/n\n- **GitHub:** gh/n\n<!-- secret note -->\n\n## Summary\nDev.\n',
    preferences: 'p',
  });
  for (const hidden of ['050-1', 'n@x.io', 'li/n', 'gh/n', 'secret note']) assert.equal(prompt.includes(hidden), false, hidden);
  assert.match(prompt, /Location:\*\* Tel Aviv/);
});
