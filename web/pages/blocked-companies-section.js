import { postJson, requestJson } from '../shared/api-client.js';

const section = document.querySelector('#blocked-companies');
const list = document.querySelector('#blocked-list');

async function load() {
  const { blocked } = await requestJson('/api/companies/blocked');
  section.hidden = !blocked.length;
  list.replaceChildren(...blocked.map(({ key, company }) => {
    const item = document.createElement('li');
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-small button-secondary', textContent: 'ביטול חסימה' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await postJson('/api/companies/unblock', { key });
        await load();
      } catch {
        remove.disabled = false;
      }
    });
    item.append(Object.assign(document.createElement('span'), { textContent: company || key }), remove);
    return item;
  }));
}

load().catch(() => {});
