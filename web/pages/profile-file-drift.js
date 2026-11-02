import { postJson } from '../shared/api-client.js';

const KIND_LABELS = { resume: 'קורות החיים', preferences: 'ההעדפות', profile: 'העובדות הנוספות', stories: 'הסיפורים לראיונות' };

// Tells that a file under profile/ was edited by hand, and offers to take it in.
export function createFileDriftNotice({ root, kinds, feedback, onAdopted }) {
  return {
    show(drifted) {
      const shown = drifted.filter((kind) => kinds.includes(kind));
      root.replaceChildren(...shown.map((kind) => {
        const adopt = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-small button-secondary', textContent: 'קליטת הקובץ' });
        adopt.addEventListener('click', async () => {
          try {
            await postJson(`/api/profile/documents/${kind}/adopt-file`);
            await onAdopted();
            feedback('הקובץ נקלט.');
          } catch (error) {
            feedback(error.message, true);
          }
        });
        const line = Object.assign(document.createElement('p'), { textContent: `הקובץ של ${KIND_LABELS[kind]} ב-profile/ נערך ידנית, והמערכת עדיין משתמשת בגרסה השמורה כאן.` });
        line.append(' ', adopt);
        return line;
      }));
      root.hidden = !shown.length;
    },
  };
}
