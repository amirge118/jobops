import { postJson } from '../shared/api-client.js';

export function createCvImport({ onDraft, feedback }) {
  const text = document.querySelector('#cv-text');
  const run = document.querySelector('#cv-import-run');
  const warnings = document.querySelector('#cv-import-warnings');

  run.addEventListener('click', async () => {
    run.disabled = true;
    feedback('מארגן את קורות החיים, זה עשוי לקחת עד דקה או שתיים…');
    try {
      const { draft } = await postJson('/api/profile/import-draft', { text: text.value });
      warnings.replaceChildren(...draft.warnings.map((warning) => Object.assign(document.createElement('li'), { textContent: warning })));
      warnings.hidden = !draft.warnings.length;
      onDraft(draft);
      feedback('הטיוטה מוצגת למטה ועדיין לא נשמרה. בדוק שהכול נכון ולחץ על שמירה.');
    } catch (error) {
      feedback(error.message, true);
    } finally {
      run.disabled = false;
    }
  });
}
