import { postJson, requestJson } from '../shared/api-client.js';

const LIST = 'list';
const TEXT = 'text';
const SCORE = 'score';
const BOOLEAN = 'boolean';
const LANGUAGE = 'language';
const LANGUAGES = [['Hebrew', 'עברית'], ['English', 'English'], ['Arabic', 'العربية'], ['Russian', 'Русский']];

const GROUPS = [
  {
    title: 'מה אני מחפש',
    hint: 'משפיע על הציונים.',
    fields: [
      { key: 'search.focusRole', label: 'התפקיד המרכזי', type: TEXT, placeholder: 'למשל: Product Designer' },
      { key: 'filters.domains', label: 'תחומי יעד', type: LIST },
      { key: 'search.excludedRoleTypes', label: 'תחומים שלא מתאימים', type: LIST },
      { key: 'filters.preferredSectors', label: 'סקטורים מועדפים', type: LIST },
      { key: 'filters.acceptedLocations', label: 'מיקומים מתאימים', type: LIST },
      { key: 'search.homeCountry', label: 'מדינה', type: TEXT },
      { key: 'search.maxLevel', label: 'הדרגה הגבוהה ביותר', type: TEXT, placeholder: 'למשל: Senior' },
      { key: 'search.levelCapTitles', label: 'כותרות מעל הדרגה הזו', type: LIST },
      { key: 'search.avoidPeopleManagement', label: 'לא מחפש תפקיד ניהול אנשים', type: BOOLEAN },
      { key: 'ai.outputLanguage', label: 'שפת הסיכומים והסיבות', type: LANGUAGE },
    ],
  },
  {
    title: 'סף התאמה',
    hint: 'חל על משרות שינוקדו מעכשיו, בלי עלות.',
    fields: [
      { key: 'decision.minimumScore', label: 'ציון מינימלי למשרה מתאימה', type: SCORE },
      { key: 'decision.exactMatchScore', label: 'ציון להתאמה מדויקת', type: SCORE },
    ],
  },
  {
    title: 'סינון ראשוני של כותרות',
    hint: 'סינון חינמי לפני הניקוד. משרה שנפסלת כאן לא תיבדק ולא תופיע, ולכן רשימה צרה מדי מסתירה משרות טובות.',
    action: true,
    fields: [
      { key: 'search.titleFilter.positive', label: 'כותרת חייבת לכלול אחד מאלה', type: LIST },
      { key: 'search.titleFilter.negative', label: 'לפסול כותרת שכוללת', type: LIST },
      { key: 'search.titleFilter.alwaysAllow', label: 'תמיד להשאיר כותרת שכוללת', type: LIST },
    ],
  },
  {
    title: 'סינון ראשוני של מיקומים',
    hint: 'סינון חינמי לפני הניקוד.',
    fields: [
      { key: 'search.locationFilter.alwaysAllow', label: 'תמיד להשאיר', type: LIST },
      { key: 'search.locationFilter.allow', label: 'מיקומים מותרים', type: LIST },
      { key: 'search.locationFilter.block', label: 'מיקומים חסומים', type: LIST },
    ],
  },
];

const valueAt = (source, key) => key.split('.').reduce((value, part) => value?.[part], source);

function createInput(field) {
  if (field.type === LANGUAGE) {
    const select = document.createElement('select');
    select.append(...LANGUAGES.map(([value, label]) => new Option(label, value)));
    return select;
  }
  if (field.type === LIST) return Object.assign(document.createElement('textarea'), { rows: 4, dir: 'auto' });
  if (field.type === BOOLEAN) return Object.assign(document.createElement('input'), { type: 'checkbox' });
  if (field.type === SCORE) return Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 5, step: 0.1 });
  return Object.assign(document.createElement('input'), { type: 'text', dir: 'auto', maxLength: 200, placeholder: field.placeholder ?? '' });
}

function read(field, input) {
  if (field.type === LIST) return input.value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (field.type === BOOLEAN) return input.checked;
  if (field.type === SCORE) return input.value === '' ? null : Number(input.value);
  return input.value.trim();
}

function write(field, input, value) {
  if (field.type === LIST) input.value = (value ?? []).join('\n');
  else if (field.type === BOOLEAN) input.checked = Boolean(value);
  else input.value = value ?? '';
}

export function createSearchForm({ form, feedback, onSaved }) {
  const controls = [];
  let saved = {};
  const suggest = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-secondary', textContent: 'הצעת מסננים לפי מה שאני מחפש' });

  for (const group of GROUPS) {
    const box = document.createElement('fieldset');
    box.className = 'profile-group';
    box.append(Object.assign(document.createElement('legend'), { textContent: group.title }), Object.assign(document.createElement('p'), { className: 'profile-hint', textContent: group.hint }));
    const grid = Object.assign(document.createElement('div'), { className: 'profile-fields' });
    for (const field of group.fields) {
      const input = createInput(field);
      input.id = `setting-${field.key.replaceAll('.', '-')}`;
      const wrapper = document.createElement('div');
      wrapper.append(Object.assign(document.createElement('label'), { htmlFor: input.id, textContent: field.label }), input);
      grid.append(wrapper);
      controls.push({ field, input });
    }
    box.append(grid);
    if (group.action) box.append(suggest);
    form.append(box);
  }
  const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'button button-primary', textContent: 'שמירת ההגדרות' });
  form.append(save);

  const fill = (settings) => {
    for (const { field, input } of controls) write(field, input, valueAt(settings, field.key));
    saved = current();
  };
  function current() {
    return Object.fromEntries(controls.map(({ field, input }) => [field.key, read(field, input)]));
  }
  const changed = () => {
    const now = current();
    return Object.fromEntries(Object.entries(now).filter(([key, value]) => value !== null && JSON.stringify(value) !== JSON.stringify(saved[key])));
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const settings = changed();
      if (Object.keys(settings).length) fill(await postJson('/api/profile/search', { settings }));
      feedback('ההגדרות נשמרו.');
      onSaved();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      save.disabled = false;
    }
  });

  suggest.addEventListener('click', async () => {
    suggest.disabled = true;
    feedback('מכין הצעה…');
    try {
      const { suggestion } = await postJson('/api/profile/search/suggest-filters');
      const lists = { 'search.titleFilter.positive': suggestion.positive, 'search.titleFilter.negative': suggestion.negative, 'search.titleFilter.alwaysAllow': suggestion.alwaysAllow };
      for (const { field, input } of controls) if (lists[field.key]) write(field, input, lists[field.key]);
      feedback('ההצעה מוצגת ועדיין לא נשמרה. עבור עליה ושמור.');
    } catch (error) {
      feedback(error.message, true);
    } finally {
      suggest.disabled = false;
    }
  });

  return {
    load: async () => fill(await requestJson('/api/profile/search')),
    isDirty: () => Object.keys(changed()).length > 0,
  };
}
