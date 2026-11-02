import { postJson, requestJson } from '../shared/api-client.js';
import { formatTime } from '../shared/formatters.js';
import { initTabs } from '../shared/tabs.js';
import { createCvImport } from './profile-cv-import.js';
import { createDocumentEditor } from './profile-document-editor.js';
import { createCvExplanation } from './profile-explanation.js';
import { createFileCard } from './profile-file-card.js';
import { createFileDriftNotice } from './profile-file-drift.js';
import { createIdentityForm } from './profile-identity-form.js';
import { createRescoreBanner } from './profile-rescore-banner.js';

// These tabs moved. Old links and bookmarks still reach them.
const MOVED_TABS = { preferences: '/settings#preferences', sources: '/settings#sources', stories: '/personal-area#stories' };
const movedTo = MOVED_TABS[window.location.hash.slice(1)];
if (movedTo) window.location.replace(movedTo);

const feedbackLine = document.querySelector('#page-feedback');
const progress = document.querySelector('#cv-progress');
const warnings = document.querySelector('#cv-warnings');

function feedback(message, isError = false) {
  feedbackLine.textContent = message;
  feedbackLine.dataset.state = isError ? 'error' : '';
}

function showProgress(message) {
  progress.textContent = message;
  progress.hidden = !message;
}

function showWarnings(lines) {
  warnings.replaceChildren(...lines.map((line) => Object.assign(document.createElement('li'), { textContent: line })));
  warnings.hidden = !lines.length;
}

const editors = {};
let identityForm;
const rescoreBanner = createRescoreBanner({ root: document.querySelector('#rescore-banner'), feedback });
const drift = createFileDriftNotice({ root: document.querySelector('#file-drift'), kinds: ['resume', 'profile'], feedback, onAdopted: load });

async function loadInsights() {
  const [insights, gaps] = await Promise.all([
    requestJson('/api/profile/resume-insights'),
    requestJson('/api/personal-area/insights').catch(() => null),
  ]);
  explanation.render(insights, gaps);
}

async function explain() {
  showProgress('כותב הסבר על קורות החיים, זה עשוי לקחת עד דקה או שתיים…');
  try {
    const { failed } = await postJson('/api/profile/resume-insights');
    if (failed.length) feedback('חלק מההסבר לא נכתב כרגע. אפשר לנסות שוב בעוד כמה דקות.', true);
    await loadInsights();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    showProgress('');
  }
}

const explanation = createCvExplanation({
  root: document.querySelector('#cv-explanation'),
  feedback,
  onExplain: explain,
  onChanged: () => refreshQuietly(),
});

const fileCard = createFileCard({
  root: document.querySelector('#cv-file-card'),
  feedback,
  showProgress,
  getVersion: () => editors.resume.version(),
  hasUnsavedText: () => editors.resume.isDirty(),
  onUploaded: async (result) => {
    showWarnings(result.warnings);
    await refreshFromServer();
    await editors.resume.load((await requestJson('/api/profile')).documents.resume);
    await explain();
    feedback(`הקובץ נשמר.${result.fileCopy === 'conflict' ? ' הקובץ ב-profile/ נערך ידנית ולכן לא עודכן.' : ''}`);
  },
});

async function load() {
  const overview = await requestJson('/api/profile');
  for (const [kind, editor] of Object.entries(editors)) await editor.load(overview.documents[kind]);
  identityForm.load(overview.identity);
  fileCard.render(overview.resumeFile, Boolean(overview.documents.resume));
  drift.show(overview.fileDrift);
  await Promise.all([rescoreBanner.refresh(), loadInsights()]);
  document.querySelector('#last-updated').textContent = `עודכן ${formatTime(Date.now())}`;
}

// A save may change what another tab shows. A tab with unsaved edits is left
// alone: its text stays, and saving it reports the conflict instead of losing it.
async function refreshFromServer() {
  const overview = await requestJson('/api/profile');
  if (!identityForm.isDirty()) identityForm.load(overview.identity);
  if (!editors.profile.isDirty()) await editors.profile.load(overview.documents.profile);
  fileCard.render(overview.resumeFile, Boolean(overview.documents.resume));
}

const refreshQuietly = () => Promise.all([refreshFromServer(), rescoreBanner.refresh(), loadInsights()]).catch(() => {});

editors.resume = createDocumentEditor({ root: document.querySelector('#editor-resume'), kind: 'resume', feedback, onSaved: refreshQuietly });
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

initTabs();

window.addEventListener('beforeunload', (event) => {
  if (Object.values(editors).some((editor) => editor.isDirty()) || identityForm.isDirty()) event.preventDefault();
});

load().catch((error) => feedback(error.message, true));
