import { postJson, requestJson } from '../shared/api-client.js';

const SOURCE_LABELS = { ats: 'אתרי קריירה של חברות', whatsapp: 'קבוצות WhatsApp', linkedin: 'LinkedIn' };
const MAX_SEARCHES = 6;

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function field(label, input) {
  input.id = input.id || `source-field-${crypto.randomUUID()}`;
  return element('div', {}, element('label', { htmlFor: input.id, textContent: label }), input);
}

function group(title, hint, ...children) {
  return element('fieldset', { className: 'profile-group' }, element('legend', { textContent: title }), element('p', { className: 'profile-hint', textContent: hint }), ...children);
}

const keyFor = (keywords) => keywords.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `search-${Date.now()}`;

// Where jobs come from and how you hear about them.
export function createSourcesSection({ root, feedback }) {
  async function act(button, action, message) {
    button.disabled = true;
    try {
      render(await action());
      feedback(message);
    } catch (error) {
      feedback(error.message, true);
      button.disabled = false;
    }
  }

  function renderToggles(data) {
    return group('מקורות פעילים', 'מקור כבוי לא נסרק. הסריקה של LinkedIn מנוהלת גם בעמוד הסריקה.', ...['ats', 'whatsapp'].map((source) => {
      const input = element('input', { type: 'checkbox', checked: data.enabled[source], disabled: !data.canEditSources, id: `source-${source}` });
      input.addEventListener('change', () => act(input, () => postJson(`/api/sources/${source}/enabled`, { enabled: input.checked }), 'נשמר.'));
      return element('p', {}, input, element('label', { htmlFor: input.id, textContent: ` ${SOURCE_LABELS[source]}` }));
    }));
  }

  function renderGroups(data) {
    const boxes = data.groups.map((item) => {
      const input = element('input', { type: 'checkbox', checked: item.selected, value: item.id, disabled: !data.canEditSources, id: `group-${item.id}` });
      const size = item.participants ? ` (${item.participants})` : '';
      return element('p', {}, input, element('label', { htmlFor: input.id, textContent: ` ${item.name}${size}` }));
    });
    const save = element('button', { type: 'button', className: 'button button-primary', textContent: 'שמירת הקבוצות', disabled: !data.canEditSources });
    save.addEventListener('click', () => act(save, () => postJson('/api/sources/whatsapp/groups', {
      ids: boxes.map((box) => box.querySelector('input')).filter((input) => input.checked).map((input) => input.value),
    }), 'הקבוצות נשמרו. החיבור ל-WhatsApp מופעל מחדש.'));
    const hint = data.groups.length
      ? 'רק קבוצות מסומנות נקראות. הרשימה מתעדכנת בכל חיבור ל-WhatsApp.'
      : 'הרשימה תופיע אחרי החיבור הבא ל-WhatsApp.';
    return group('קבוצות WhatsApp', hint, ...boxes, ...(data.groups.length ? [save] : []));
  }

  function searchRow(search = {}) {
    const keywords = element('input', { type: 'text', value: search.keywords ?? '', dir: 'auto', maxLength: 200 });
    const location = element('input', { type: 'text', value: search.location ?? '', dir: 'auto', maxLength: 120 });
    const remove = element('button', { type: 'button', className: 'button button-small button-secondary', textContent: 'מחיקה' });
    const row = element('div', { className: 'profile-fields' }, field('מילות חיפוש', keywords), field('מיקום', location), remove);
    remove.addEventListener('click', () => row.remove());
    row.readSearch = () => ({
      key: search.key ?? keyFor(keywords.value),
      label: search.label && search.keywords === keywords.value ? search.label : keywords.value,
      keywords: keywords.value,
      location: location.value,
      ...(search.geoId ? { geoId: search.geoId } : {}),
      ...(search.titleIncludes ? { titleIncludes: search.titleIncludes } : {}),
    });
    return row;
  }

  function renderSearches(data) {
    const rows = element('div', {}, ...data.linkedinSearches.map(searchRow));
    const add = element('button', { type: 'button', className: 'button button-secondary', textContent: 'הוספת חיפוש', disabled: !data.canEditSources });
    add.addEventListener('click', () => {
      if (rows.children.length < MAX_SEARCHES) rows.append(searchRow());
      else feedback(`אפשר עד ${MAX_SEARCHES} חיפושים.`, true);
    });
    const save = element('button', { type: 'button', className: 'button button-primary', textContent: 'שמירת החיפושים', disabled: !data.canEditSources });
    save.addEventListener('click', () => act(save, () => postJson('/api/sources/linkedin/searches', { searches: [...rows.children].map((row) => row.readSearch()) }), 'החיפושים נשמרו ויחולו מהסריקה הבאה.'));
    return group('חיפושי LinkedIn', `עד ${MAX_SEARCHES} חיפושים. כמות הבקשות המותרת קבועה, לכן ככל שיש יותר חיפושים כל אחד מתעדכן לאט יותר.`, rows, element('div', { className: 'profile-actions' }, save, add));
  }

  function renderNotifications(data) {
    const enabled = element('input', { type: 'checkbox', checked: data.notifications.enabled, id: 'notify-enabled' });
    const minScore = element('input', { type: 'number', min: 0, max: 5, step: 0.1, value: data.notifications.minScore ?? '' });
    const save = element('button', { type: 'button', className: 'button button-primary', textContent: 'שמירה' });
    save.addEventListener('click', () => act(save, () => postJson('/api/sources/notifications', {
      enabled: enabled.checked, ...(minScore.value === '' ? {} : { minScore: Number(minScore.value) }),
    }), 'נשמר. השינוי יחול מהסריקה הבאה.'));
    return group('התראות ב-WhatsApp', 'הודעה לעצמך על משרה חדשה מתאימה.', element('p', {}, enabled, element('label', { htmlFor: enabled.id, textContent: ' לשלוח התראות' })), field('ציון מינימלי להתראה', minScore), save);
  }

  function render(data) {
    root.replaceChildren(renderToggles(data), renderGroups(data), renderSearches(data), renderNotifications(data));
  }

  return { load: async () => render(await requestJson('/api/sources')) };
}
