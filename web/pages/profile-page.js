import { postJson, requestJson } from '../shared/api-client.js';
import { formatTime } from '../shared/formatters.js';
import { createCvImport } from './profile-cv-import.js';
import { createDocumentEditor } from './profile-document-editor.js';
import { createIdentityForm } from './profile-identity-form.js';
import { createRescoreBanner } from './profile-rescore-banner.js';
import { createSearchForm } from './profile-search-form.js';
import { createSourcesSection } from './profile-sources-section.js';

const KIND_LABELS = { resume: 'קורות החיים', preferences: 'ההעדפות', profile: 'המידע הנוסף' };
const feedbackLine = document.querySelector('#page-feedback');
const drift = document.querySelector('#file-drift');

function feedback(message, isError = false) {
  feedbackLine.textContent = message;
  feedbackLine.dataset.state = isError ? 'error' : '';
}

function showDrift(kinds) {
  drift.replaceChildren(...kinds.map((kind) => {
    const adopt = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-small button-secondary', textContent: 'קליטת הקובץ' });
    adopt.addEventListener('click', async () => {
      try {
        await postJson(`/api/profile/documents/${kind}/adopt-file`);
        await load();
        feedback('הקובץ נקלט.');
      } catch (error) {
        feedback(error.message, true);
      }
    });
    const line = Object.assign(document.createElement('p'), { textContent: `הקובץ של ${KIND_LABELS[kind]} ב-profile/ נערך ידנית, והמערכת עדיין משתמשת בגרסה השמורה כאן.` });
    line.append(' ', adopt);
    return line;
  }));
  drift.hidden = !kinds.length;
}

const editors = {};
let identityForm;
const rescoreBanner = createRescoreBanner({ root: document.querySelector('#rescore-banner'), feedback });
const sourcesSection = createSourcesSection({ root: document.querySelector('#sources-root'), feedback });
const searchForm = createSearchForm({ form: document.querySelector('#search-form'), feedback, onSaved: () => rescoreBanner.refresh() });

async function load() {
  const overview = await requestJson('/api/profile');
  for (const [kind, editor] of Object.entries(editors)) await editor.load(overview.documents[kind]);
  identityForm.load(overview.identity);
  showDrift(overview.fileDrift);
  await Promise.all([searchForm.load(), rescoreBanner.refresh(), sourcesSection.load()]);
  document.querySelector('#last-updated').textContent = `עודכן ${formatTime(Date.now())}`;
}

// A save may change what another tab shows. A tab with unsaved edits is left
// alone: its text stays, and saving it reports the conflict instead of losing it.
async function refreshFromServer() {
  const overview = await requestJson('/api/profile');
  if (!identityForm.isDirty()) identityForm.load(overview.identity);
  if (!editors.profile.isDirty()) await editors.profile.load(overview.documents.profile);
}

const refreshQuietly = () => Promise.all([refreshFromServer(), rescoreBanner.refresh()]).catch(() => {});

editors.resume = createDocumentEditor({ root: document.querySelector('#editor-resume'), kind: 'resume', feedback, onSaved: refreshQuietly });
editors.preferences = createDocumentEditor({ root: document.querySelector('#editor-preferences'), kind: 'preferences', feedback, onSaved: () => rescoreBanner.refresh() });
editors.profile = createDocumentEditor({ root: document.querySelector('#editor-profile'), kind: 'profile', feedback, onSaved: refreshQuietly });
identityForm = createIdentityForm({
  form: document.querySelector('#identity-form'),
  getVersion: () => editors.profile.version(),
  feedback,
  onSaved: refreshQuietly,
});
createCvImport({
  feedback,
  onDraft: (draft) => {
    editors.resume.showDraft(draft.markdown);
    identityForm.showDraft(draft.identity);
  },
});

for (const tab of document.querySelectorAll('.profile-tabs [role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.profile-tabs [role="tab"]')) {
      const active = other === tab;
      other.setAttribute('aria-selected', String(active));
      document.querySelector(`#tab-${other.dataset.tab}`).hidden = !active;
    }
  });
}

window.addEventListener('beforeunload', (event) => {
  if (Object.values(editors).some((editor) => editor.isDirty()) || identityForm.isDirty() || searchForm.isDirty()) event.preventDefault();
});

load().catch((error) => feedback(error.message, true));
