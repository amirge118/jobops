import { headingText, joinSections, splitSections } from '../shared/document-sections.js';
import { requestJson, postJson } from '../shared/api-client.js';
import { formatTime } from '../shared/formatters.js';

const sourceLabels = {
  import: 'ייבוא', editor: 'עריכה', identity: 'פרטים אישיים', restore: 'שחזור', file: 'מקובץ', from_resume: 'מקורות חיים',
};

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// One document as editable sections, with its versions. Headings stay exactly
// as written unless edited, so opening and saving never changes the text.
export function createDocumentEditor({ root, kind, onSaved, feedback }) {
  let version = null;
  let preamble = '';
  let saved = '';
  const sectionsRoot = element('div', { className: 'profile-sections' });
  const saveButton = element('button', { type: 'button', className: 'button button-primary', textContent: 'שמירה' });
  const addButton = element('button', { type: 'button', className: 'button button-secondary', textContent: 'הוספת סעיף' });
  const versionsList = element('ul', { className: 'profile-versions' });
  const versions = element('details', { className: 'profile-history' }, element('summary', { textContent: 'גרסאות קודמות' }), versionsList);
  root.append(sectionsRoot, element('div', { className: 'profile-actions' }, saveButton, addButton), versions);

  function addSection({ heading = '## \n', body = '' } = {}, focus = false) {
    const title = element('input', { type: 'text', value: headingText(heading), dir: 'auto', placeholder: 'כותרת הסעיף' });
    title.setAttribute('aria-label', 'כותרת הסעיף');
    title.dataset.raw = heading;
    title.dataset.text = headingText(heading);
    const text = element('textarea', { value: body.replace(/\n+$/, ''), dir: 'auto', rows: Math.min(18, Math.max(3, body.split('\n').length + 1)) });
    text.setAttribute('aria-label', 'תוכן הסעיף');
    text.dataset.raw = body;
    text.dataset.text = text.value;
    const remove = element('button', { type: 'button', className: 'button button-small button-secondary', textContent: 'מחיקה' });
    const row = element('div', { className: 'profile-section' }, element('div', { className: 'profile-section-head' }, title, remove), text);
    remove.addEventListener('click', () => row.remove());
    sectionsRoot.append(row);
    if (focus) title.focus();
  }

  function currentText() {
    const sections = [...sectionsRoot.querySelectorAll('.profile-section')].map((row) => {
      const title = row.querySelector('input');
      const text = row.querySelector('textarea');
      return {
        heading: title.value.trim() === title.dataset.text ? title.dataset.raw : `## ${title.value.trim()}\n`,
        body: text.value === text.dataset.text ? text.dataset.raw : `${text.value.replace(/\n+$/, '')}\n\n`,
      };
    }).filter((section) => headingText(section.heading) || section.body.trim());
    return joinSections({ preamble, sections });
  }

  function load(document_) {
    version = document_?.version ?? null;
    saved = document_?.content ?? '';
    const parsed = splitSections(saved);
    preamble = parsed.preamble;
    sectionsRoot.replaceChildren();
    parsed.sections.forEach((section) => addSection(section));
    if (!parsed.sections.length) addSection();
  }

  async function refreshVersions() {
    const { versions: rows } = await requestJson(`/api/profile/documents/${kind}/versions`);
    versionsList.replaceChildren(...rows.slice(1).map((row) => {
      const restore = element('button', { type: 'button', className: 'button button-small button-secondary', textContent: 'שחזור' });
      restore.addEventListener('click', () => run(() => postJson(`/api/profile/documents/${kind}/restore`, { version: row.version, baseVersion: version }), 'הגרסה שוחזרה.'));
      return element('li', {}, element('span', { textContent: `${formatTime(row.createdAt)} · ${sourceLabels[row.source] || row.source}` }), restore);
    }));
    versions.hidden = rows.length < 2;
  }

  async function run(action, message) {
    saveButton.disabled = true;
    try {
      const result = await action();
      load(result.document);
      await refreshVersions();
      feedback(result.fileCopy === 'conflict' ? 'נשמר. הקובץ ב-profile/ נערך ידנית ולכן לא עודכן.' : message);
      onSaved?.(kind, result);
    } catch (error) {
      feedback(error.message, true);
    } finally {
      saveButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', () => run(
    () => postJson(`/api/profile/documents/${kind}`, { content: currentText(), baseVersion: version }),
    'נשמר.',
  ));
  addButton.addEventListener('click', () => addSection({}, true));

  return {
    load: async (document_) => { load(document_); await refreshVersions(); },
    // A draft replaces what is on screen only; the saved document stays until "save".
    showDraft: (markdown) => {
      const parsed = splitSections(markdown);
      preamble = parsed.preamble;
      sectionsRoot.replaceChildren();
      parsed.sections.forEach((section) => addSection(section));
    },
    isDirty: () => currentText() !== saved,
    version: () => version,
  };
}
