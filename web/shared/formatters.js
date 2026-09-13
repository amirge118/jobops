export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

export function formatTime(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

export function syncStatCard(element, value) {
  const count = Number(value || 0);
  element.textContent = count;
  if (element.parentElement?.dataset) element.parentElement.dataset.empty = String(count === 0);
}

export function validJobUrl(value) {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}
