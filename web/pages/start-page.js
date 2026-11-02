import { requestJson } from '../shared/api-client.js';

const STEPS = {
  resume: { title: 'קורות החיים שלך', text: 'מדביקים את הטקסט, והמערכת מארגנת אותו בסעיפים לאישור שלך.', href: '/profile', action: 'לקורות החיים' },
  search: { title: 'מה אתה מחפש', text: 'תפקיד, תחומים, מיקום ודרגה. על זה מבוסס הציון של כל משרה.', href: '/profile#preferences', action: 'להגדרת החיפוש' },
  filters: { title: 'סינון ראשוני', text: 'מילות המפתח שמסננות כותרות לפני הניקוד. אפשר לקבל הצעה מותאמת לתחום שלך.', href: '/profile#preferences', action: 'למסננים' },
  sources: { title: 'מקורות', text: 'מאיפה להביא משרות: חברות במעקב, חיפושי LinkedIn או קבוצות.', href: '/profile#sources', action: 'למקורות' },
  scan: { title: 'סריקה ראשונה', text: 'מריצים סריקה ורואים את המשרות המתאימות בעמוד ההחלטות.', href: '/scan', action: 'לסריקה' },
};

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderSteps({ steps }) {
  document.querySelector('#start-steps').replaceChildren(...steps.map(({ key, done }) => {
    const step = STEPS[key];
    return element('li', { className: done ? 'start-step start-step-done' : 'start-step' },
      element('div', {},
        element('strong', { textContent: `${done ? '✓ ' : ''}${step.title}` }),
        element('p', { className: 'profile-hint', textContent: step.text })),
      element('a', { className: done ? 'button button-small button-secondary' : 'button button-small button-primary', href: step.href, textContent: step.action }));
  }));
}

function renderStatus({ readiness }) {
  const items = [readiness.scorer, readiness.browser, readiness.collector].filter(Boolean);
  document.querySelector('#start-status').replaceChildren(...items.map((item) => {
    const line = element('li', {}, element('strong', { textContent: `${item.status === 'ready' ? '✓' : '!'} ${item.label}` }));
    if (item.status !== 'ready') line.append(element('p', { className: 'profile-hint', textContent: [item.reason, item.nextStep].filter(Boolean).join(' ') }));
    return line;
  }));
}

requestJson('/api/onboarding').then(renderSteps).catch((error) => {
  document.querySelector('#page-feedback').textContent = error.message;
});
requestJson('/api/readiness').then(renderStatus).catch(() => {});
