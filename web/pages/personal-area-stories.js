import { requestJson } from '../shared/api-client.js';
import { createDocumentEditor } from './profile-document-editor.js';
import { createFileDriftNotice } from './profile-file-drift.js';

const section = document.querySelector('#stories');
const feedbackLine = document.querySelector('#page-feedback');

function feedback(message, isError = false) {
  feedbackLine.textContent = message;
  feedbackLine.dataset.state = isError ? 'error' : '';
}

const editor = createDocumentEditor({ root: document.querySelector('#editor-stories'), kind: 'stories', feedback });
const drift = createFileDriftNotice({ root: document.querySelector('#file-drift'), kinds: ['stories'], feedback, onAdopted: load });

async function load() {
  const overview = await requestJson('/api/profile');
  await editor.load(overview.documents.stories);
  drift.show(overview.fileDrift);
}

// Old links to the stories tab land here, closed sections included.
if (window.location.hash === '#stories') {
  section.open = true;
  section.scrollIntoView();
}

window.addEventListener('beforeunload', (event) => {
  if (editor.isDirty()) event.preventDefault();
});

load().catch((error) => feedback(error.message, true));
