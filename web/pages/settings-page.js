import { requestJson } from '../shared/api-client.js';
import { formatTime } from '../shared/formatters.js';
import { initTabs } from '../shared/tabs.js';
import { createDocumentEditor } from './profile-document-editor.js';
import { createFileDriftNotice } from './profile-file-drift.js';
import { createRescoreBanner } from './profile-rescore-banner.js';
import { createSearchForm } from './profile-search-form.js';
import { createSourcesSection } from './profile-sources-section.js';

const feedbackLine = document.querySelector('#page-feedback');

function feedback(message, isError = false) {
  feedbackLine.textContent = message;
  feedbackLine.dataset.state = isError ? 'error' : '';
}

const rescoreBanner = createRescoreBanner({ root: document.querySelector('#rescore-banner'), feedback });
const sourcesSection = createSourcesSection({ root: document.querySelector('#sources-root'), feedback });
const searchForm = createSearchForm({ form: document.querySelector('#search-form'), feedback, onSaved: () => rescoreBanner.refresh() });
const preferences = createDocumentEditor({ root: document.querySelector('#editor-preferences'), kind: 'preferences', feedback, onSaved: () => rescoreBanner.refresh() });
const drift = createFileDriftNotice({ root: document.querySelector('#file-drift'), kinds: ['preferences'], feedback, onAdopted: load });

async function load() {
  const overview = await requestJson('/api/profile');
  await preferences.load(overview.documents.preferences);
  drift.show(overview.fileDrift);
  await Promise.all([searchForm.load(), rescoreBanner.refresh(), sourcesSection.load()]);
  document.querySelector('#last-updated').textContent = `עודכן ${formatTime(Date.now())}`;
}

initTabs();

window.addEventListener('beforeunload', (event) => {
  if (preferences.isDirty() || searchForm.isDirty()) event.preventDefault();
});

load().catch((error) => feedback(error.message, true));
