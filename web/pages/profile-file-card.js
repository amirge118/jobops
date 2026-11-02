import { postJson } from '../shared/api-client.js';
import { formatTime } from '../shared/formatters.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('לא הצלחנו לקרוא את הקובץ.'));
    reader.readAsDataURL(file);
  });
}

// The uploaded file: a drop zone until there is one, and its details afterwards.
export function createFileCard({ root, feedback, showProgress, getVersion, hasUnsavedText, onUploaded }) {
  let busy = false;
  const input = element('input', { type: 'file', accept: '.pdf,.docx', hidden: true });
  input.setAttribute('aria-label', 'בחירת קובץ קורות חיים');

  async function upload(file) {
    if (!file || busy) return;
    if (hasUnsavedText()) {
      feedback('יש שינויים בטקסט שעדיין לא נשמרו. שמור אותם לפני העלאת קובץ.', true);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      feedback('הקובץ גדול מ-10MB.', true);
      return;
    }
    busy = true;
    root.dataset.busy = 'true';
    feedback('');
    showProgress('קורא את הקובץ ומארגן את הטקסט, זה עשוי לקחת עד דקה או שתיים…');
    try {
      const result = await postJson('/api/profile/resume-file', { fileName: file.name, contentBase64: await asBase64(file), baseVersion: getVersion() });
      await onUploaded(result);
    } catch (error) {
      feedback(error.message, true);
      showProgress('');
    } finally {
      busy = false;
      delete root.dataset.busy;
      input.value = '';
    }
  }

  input.addEventListener('change', () => upload(input.files[0]));
  root.addEventListener('dragover', (event) => {
    event.preventDefault();
    root.dataset.over = 'true';
  });
  root.addEventListener('dragleave', () => { delete root.dataset.over; });
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    delete root.dataset.over;
    upload(event.dataTransfer.files[0]);
  });

  const chooseButton = (label, className) => {
    const button = element('button', { type: 'button', className: `button ${className}`, textContent: label });
    button.addEventListener('click', () => input.click());
    return button;
  };

  return {
    render(meta, hasResume) {
      root.replaceChildren(input, meta
        ? element('div', { className: 'cv-file' },
          element('div', { className: 'cv-file-details' },
            element('strong', { textContent: meta.fileName, dir: 'auto' }),
            element('small', { textContent: `הועלה ${formatTime(meta.createdAt)}${meta.textEdited ? ' · הטקסט נערך אחרי העלאת הקובץ' : ''}` })),
          element('div', { className: 'profile-actions' },
            chooseButton('החלפת קובץ', 'button-secondary'),
            element('a', { className: 'button button-secondary', href: '/api/profile/resume-file', textContent: 'הורדה' })))
        : element('div', { className: 'cv-drop' },
          element('strong', { textContent: 'גרור לכאן קובץ PDF או Word' }),
          element('p', { className: 'profile-hint', textContent: hasResume
            ? 'קורות החיים שלך שמורים כטקסט, בלי קובץ. העלאת קובץ תחליף את הטקסט, ואפשר לשחזר אותו מהגרסאות הקודמות.'
            : 'המערכת תקרא אותו, תסביר איך היא מבינה אותך ותציע מה לשפר.' }),
          chooseButton('בחירת קובץ', 'button-primary')));
    },
  };
}
