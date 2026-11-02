import { postJson } from '../shared/api-client.js';

const IDENTITY_LABELS = {
  name: 'שם', location: 'מיקום', phone: 'טלפון', email: 'אימייל', linkedin: 'LinkedIn', github: 'GitHub', languages: 'שפות', status: 'סטטוס',
};
const MAX_GAP_TOPICS = 5;

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const auto = (tag, textContent) => element(tag, { textContent, dir: 'auto' });

function block(title, ...children) {
  return element('section', { className: 'cv-block' }, element('h2', { className: 'profile-subtitle', textContent: title }), ...children);
}

function chips(label, values) {
  if (!values.length) return null;
  return element('div', { className: 'cv-chips' }, element('small', { textContent: label }), ...values.map((value) => element('span', { className: 'cv-chip', textContent: value, dir: 'auto' })));
}

// Everything here comes from the AI or from the CV, so it only ever becomes text.
export function createCvExplanation({ root, feedback, onExplain, onChanged }) {
  function summaryBlock(analysis) {
    if (!analysis) {
      const button = element('button', { type: 'button', className: 'button button-primary', textContent: 'כתיבת הסבר' });
      button.addEventListener('click', onExplain);
      return block('איך המערכת מבינה אותך', element('p', { className: 'profile-hint', textContent: 'עדיין אין הסבר לטקסט הנוכחי של קורות החיים.' }), button);
    }
    return block('איך המערכת מבינה אותך',
      ...[analysis.headline && element('p', { className: 'cv-headline', textContent: analysis.headline, dir: 'auto' }),
        auto('p', analysis.summary),
        chips('חוזקות', analysis.strengths),
        chips('מכוון למשרות', analysis.targetRoles)].filter(Boolean));
  }

  function factRow(item, selected, refresh) {
    const dismiss = element('button', { type: 'button', className: 'button button-small button-secondary', textContent: 'לא רלוונטי' });
    dismiss.addEventListener('click', async () => {
      try {
        refresh(await postJson('/api/profile/resume-facts/dismiss', { ids: [item.id] }));
      } catch (error) {
        feedback(error.message, true);
      }
    });
    if (item.kind === 'conflict') {
      return element('li', { className: 'cv-fact cv-fact-conflict' },
        element('div', {}, auto('strong', item.note || 'יש כאן סתירה מול העובדות שלך'), auto('p', item.quote),
          element('a', { href: '#profile', textContent: 'בדיקה בעובדות הנוספות', onclick: () => document.querySelector('.profile-tabs [data-tab="profile"]').click() })),
        dismiss);
    }
    const check = element('input', { type: 'checkbox' });
    check.addEventListener('change', () => (check.checked ? selected.add(item.id) : selected.delete(item.id)));
    const text = item.kind === 'identity'
      ? `${IDENTITY_LABELS[item.field]}: ${item.quote}${item.current ? ` (היום: ${item.current})` : ''}`
      : item.quote;
    return element('li', { className: 'cv-fact' }, element('label', {}, check, auto('span', text)), dismiss);
  }

  function factsBlock(facts, profileVersion, refresh) {
    if (!facts.length) return null;
    const selected = new Set();
    const approve = element('button', { type: 'button', className: 'button button-primary', textContent: 'הוספת הנבחרות' });
    approve.addEventListener('click', async () => {
      if (!selected.size) {
        feedback('לא נבחרו עובדות.', true);
        return;
      }
      approve.disabled = true;
      try {
        await postJson('/api/profile/resume-facts/approve', { ids: [...selected], baseVersion: profileVersion });
        feedback('העובדות נוספו.');
        await onChanged();
      } catch (error) {
        feedback(error.message, true);
        approve.disabled = false;
      }
    });
    return block('להוסיף לעובדות שלך',
      element('p', { className: 'profile-hint', textContent: 'אלה דברים שכתובים בקובץ וחסרים בעובדות שעליהן מבוסס הציון. רק מה שתאשר ייכנס, וזה עשוי לשנות ציונים. המערכת תשאל לפני ניקוד מחדש.' }),
      element('ul', { className: 'cv-facts' }, ...facts.map((item) => factRow(item, selected, refresh))),
      ...(facts.some(({ kind }) => kind !== 'conflict') ? [approve] : []));
  }

  function improvementsBlock(analysis, gaps) {
    const notes = (analysis?.improvements ?? []).map((item) => element('li', { className: 'cv-note' },
      auto('strong', item.title), auto('p', item.why), element('blockquote', { textContent: item.quote, dir: 'auto' })));
    const fixes = (gaps?.quickFixes ?? []).map((row) => element('li', { className: 'cv-note' },
      auto('strong', row.term), auto('p', row.suggestion || row.explanation || 'יש לך את זה לפי העובדות, אבל זה לא כתוב בקורות החיים.')));
    if (!notes.length && !fixes.length) return null;
    return block('מה כדאי לשפר בקובץ', element('ul', { className: 'cv-notes' }, ...notes, ...fixes));
  }

  function gapsBlock(gaps) {
    const topics = (gaps?.focus ?? []).slice(0, MAX_GAP_TOPICS);
    if (!topics.length) return null;
    return block('פערים מול השוק',
      element('p', { className: 'profile-hint', textContent: `מה שחוזר ב-${gaps.totals.jobs} המשרות המתאימות שנותחו וחסר בקורות החיים.` }),
      element('ul', { className: 'cv-notes' }, ...topics.map((topic) => element('li', { className: 'cv-note' },
        element('strong', { textContent: `${topic.label} · ${topic.jobs} משרות` }),
        auto('p', topic.terms.map(({ term }) => term).join(', '))))),
      element('a', { href: '/personal-area', textContent: 'כל הפערים באזור האישי' }));
  }

  function render({ analysis, facts = [], profileVersion = null }, gaps) {
    const refresh = (next) => render(next, gaps);
    root.replaceChildren(...[summaryBlock(analysis), factsBlock(facts, profileVersion, refresh), improvementsBlock(analysis, gaps), gapsBlock(gaps)].filter(Boolean));
  }

  return { render };
}
