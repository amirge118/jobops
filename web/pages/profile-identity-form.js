import { postJson } from '../shared/api-client.js';

const FIELDS = [
  ['name', 'שם מלא', 'text'], ['email', 'אימייל', 'email'], ['phone', 'טלפון', 'tel'], ['location', 'מיקום', 'text'],
  ['linkedin', 'LinkedIn', 'text'], ['github', 'GitHub', 'text'], ['languages', 'שפות', 'text'], ['status', 'סטטוס', 'text'],
];

export function createIdentityForm({ form, getVersion, onSaved, feedback }) {
  let saved = {};
  const inputs = Object.fromEntries(FIELDS.map(([key, label, type]) => {
    const input = Object.assign(document.createElement('input'), { type, id: `identity-${key}`, maxLength: 200, dir: 'auto' });
    const field = document.createElement('div');
    const title = Object.assign(document.createElement('label'), { htmlFor: input.id, textContent: label });
    field.append(title, input);
    form.append(field);
    return [key, input];
  }));
  const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'button button-primary', textContent: 'שמירה' });
  form.append(save);

  const values = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
  const fill = (identity) => {
    for (const [key, input] of Object.entries(inputs)) input.value = identity[key] ?? '';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await postJson('/api/profile/identity', { fields: values(), baseVersion: getVersion() });
      saved = values();
      feedback('נשמר.');
      onSaved(result);
    } catch (error) {
      feedback(error.message, true);
    } finally {
      save.disabled = false;
    }
  });

  return {
    load: (identity) => { fill(identity); saved = values(); },
    showDraft: (identity) => { for (const [key, value] of Object.entries(identity)) if (value && inputs[key]) inputs[key].value = value; },
    isDirty: () => JSON.stringify(values()) !== JSON.stringify(saved),
  };
}
