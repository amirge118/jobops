import { requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  main: document.querySelector('.page-main'),
  feedback: document.querySelector('#page-feedback'),
  updated: document.querySelector('#last-updated'),
  insightSummary: document.querySelector('#insights-summary'),
  focusList: document.querySelector('#focus-list'),
  quickFixes: document.querySelector('#quick-fixes'),
  quickFixList: document.querySelector('#quick-fix-list'),
  topicGrid: document.querySelector('#topic-grid'),
  minorTopics: document.querySelector('#minor-topics'),
  minorCount: document.querySelector('#minor-count'),
  minorGrid: document.querySelector('#minor-grid'),
  hidden: document.querySelector('#hidden-terms'),
  hiddenCount: document.querySelector('#hidden-count'),
  hiddenList: document.querySelector('#hidden-list'),
};
let insights = null;
// Each topic card shows its strongest terms; the rest wait behind "more".
const VISIBLE_TERMS = 4;

const kindLabels = {
  safe_addition: 'להוסיף עכשיו',
  needs_confirmation: 'לאמת',
  experience_gap: 'ללמוד',
};

function kindTag(row) {
  const label = row.kind ? kindLabels[row.kind] : 'חסר';
  return `<span class="gap-kind" data-kind="${escapeHtml(row.kind || 'missing')}">${escapeHtml(label || 'לבדיקה')}</span>`;
}

function statusButton(term, status, label) {
  return `<button class="term-status" type="button" data-term="${escapeHtml(term)}" data-status="${status}">${label}</button>`;
}

function jobsLabel(count) {
  return count === 1 ? 'משרה אחת' : `${count} משרות`;
}

function renderTermRow(row) {
  const inProgress = row.status === 'in_progress';
  const meta = [
    jobsLabel(row.jobs),
    row.required ? `${row.required} כחובה` : '',
    row.examples.length ? row.examples.join(' · ') : '',
  ].filter(Boolean).join(' · ');
  const detail = [row.explanation, row.suggestion].filter(Boolean).join(' ');
  return `<li class="topic-term" data-status="${row.status || ''}">
    <div class="topic-term-head"><strong>${escapeHtml(row.term)}</strong>${inProgress ? '<span class="term-badge">בטיפול</span>' : ''}${kindTag(row)}
      <span class="term-actions">${inProgress ? statusButton(row.term, '', 'בטל טיפול') : statusButton(row.term, 'in_progress', 'בטיפול')}${statusButton(row.term, 'hidden', 'הסתר')}</span></div>
    <small class="topic-term-meta">${escapeHtml(meta)}</small>
    ${detail ? `<p class="topic-term-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</p>` : ''}
  </li>`;
}

function renderTopic(topic) {
  const visible = topic.rows.slice(0, VISIBLE_TERMS);
  const rest = topic.rows.slice(VISIBLE_TERMS);
  return `<article class="topic-card" data-topic="${escapeHtml(topic.id)}">
    <header><h3>${escapeHtml(topic.label)}</h3><span class="topic-jobs">${jobsLabel(topic.jobs)}</span></header>
    <ul class="topic-terms">${visible.map(renderTermRow).join('')}</ul>
    ${rest.length ? `<details class="topic-more"><summary>עוד ${rest.length}</summary><ul class="topic-terms">${rest.map(renderTermRow).join('')}</ul></details>` : ''}
  </article>`;
}

function renderFocus(focus, totalJobs) {
  elements.focusList.innerHTML = focus.map((topic) => `<li>
    <strong>${escapeHtml(topic.label)}</strong><span class="focus-jobs">${topic.jobs} מתוך ${totalJobs} משרות</span>
    <span class="focus-terms">להתחיל מ: ${topic.terms.map((item) => `${escapeHtml(item.term)}${item.jobs > 1 ? ` <small>(${item.jobs})</small>` : ''}`).join(', ')}</span>
  </li>`).join('');
}

function renderInsights() {
  const { totals, coveredByResume, focus, quickFixes, topics, hidden } = insights;
  const covered = coveredByResume ? ` ${coveredByResume} נושאים שכבר מופיעים בקורות החיים הנוכחיים לא מוצגים.` : '';
  elements.insightSummary.textContent = !totals.jobs
    ? 'עדיין אין ניתוחים שמורים. הם יצטברו אוטומטית מכל משרה מתאימה בסריקות הבאות.'
    : (focus.length
      ? `מתוך ${totals.jobs} משרות מתאימות שנותחו, אלה הנושאים שחוזרים הכי הרבה. משרות שפסלת נספרות במשקל נמוך.`
      : `נותחו ${totals.jobs} משרות מתאימות ועדיין אין נושא שחוזר בשתי משרות או יותר.`) + covered;
  renderFocus(focus, totals.jobs);

  elements.quickFixes.hidden = quickFixes.length === 0;
  elements.quickFixList.innerHTML = quickFixes.map((row) => `<li><strong>${escapeHtml(row.term)}</strong><span>${escapeHtml(row.suggestion || row.explanation || '')}</span>${row.evidence ? `<small>מהפרופיל: ${escapeHtml(row.evidence)}</small>` : ''}</li>`).join('');

  // A status click re-renders everything; keep what the user had expanded.
  const expanded = new Set([...document.querySelectorAll('.topic-card')]
    .filter((card) => card.querySelector('.topic-more')?.open).map((card) => card.dataset.topic));
  const main = topics.filter((topic) => !topic.minor);
  const minor = topics.filter((topic) => topic.minor);
  elements.topicGrid.innerHTML = main.map(renderTopic).join('') || '<div class="empty-state"><strong>לא נמצאו פערים</strong></div>';
  elements.minorTopics.hidden = minor.length === 0;
  elements.minorCount.textContent = `(${minor.reduce((sum, topic) => sum + topic.rows.length, 0)})`;
  elements.minorGrid.innerHTML = minor.map(renderTopic).join('');
  for (const card of document.querySelectorAll('.topic-card')) {
    const more = card.querySelector('.topic-more');
    if (more && expanded.has(card.dataset.topic)) more.open = true;
  }

  elements.hidden.hidden = hidden.length === 0;
  elements.hiddenCount.textContent = `(${hidden.length})`;
  elements.hiddenList.innerHTML = hidden.map((item) => `<li><span>${escapeHtml(item.term)}</span><small>${jobsLabel(item.jobs)}</small>${statusButton(item.term, '', 'החזר')}</li>`).join('');
}

async function loadInsights() {
  try {
    insights = await requestJson('/api/personal-area/insights');
    renderInsights();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) {
    elements.insightSummary.textContent = error.message;
    setSystemStatus('error', error.message);
  }
}

elements.main.addEventListener('click', async (event) => {
  const button = event.target.closest('button.term-status');
  if (!button) return;
  button.disabled = true;
  try {
    await requestJson('/api/personal-area/term-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: button.dataset.term, status: button.dataset.status || null }),
    });
    elements.feedback.textContent = '';
    await loadInsights();
  } catch (error) {
    elements.feedback.textContent = error.message;
    elements.feedback.dataset.state = 'error';
    button.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) loadInsights(); });
await loadInsights();
