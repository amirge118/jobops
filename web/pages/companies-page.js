import { postJson, requestJson } from '../shared/api-client.js';
import { escapeHtml, formatTime } from '../shared/formatters.js';
import { setSystemStatus } from '../shared/app-shell.js';

const elements = {
  form: document.querySelector('#company-discovery-form'), name: document.querySelector('#company-name'),
  researchForm: document.querySelector('#company-research-form'), researchName: document.querySelector('#company-research-name'),
  url: document.querySelector('#company-url'), feedback: document.querySelector('#company-feedback'),
  preview: document.querySelector('#company-preview'), body: document.querySelector('#companies-body'),
  empty: document.querySelector('#companies-empty'), watched: document.querySelector('#watched-companies-count'),
  candidate: document.querySelector('#candidate-companies-count'), paused: document.querySelector('#paused-companies-count'),
  listSearch: document.querySelector('#company-list-search'), statusFilters: document.querySelector('.company-status-filters'),
  updated: document.querySelector('#last-updated'),
};
let companies = [];
let companyStats = {};
let activeStatus = 'all';
const statusLabels = { candidate: 'ממתינה לאישור', watched: 'במעקב', paused: 'מושהית', ignored: 'לא רלוונטית' };
const healthLabels = { healthy: 'תקין', failed: 'נכשל', unknown: 'טרם נבדק' };
const verificationLabels = {
  unverified: 'טרם נבדק', verified_jobs: 'נמצאו משרות', verified_empty: 'מקור תקין וריק',
  blocked: 'האתר חוסם סריקה', failed: 'האימות נכשל', needs_adapter: 'חסר מתאם',
  external_only: 'מקור חיצוני בלבד', stale: 'המקור התיישן',
};
const providerLabels = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable',
  recruitee: 'Recruitee', smartrecruiters: 'SmartRecruiters', comeet: 'Comeet',
  'official-html': 'עמוד קריירה רשמי', workday: 'Workday',
  'zoho-recruit': 'Zoho Recruit', teamme: 'TeamMe',
  unsupported: 'קישור חיצוני',
};
const statusOrder = { watched: 0, candidate: 1, paused: 2, ignored: 3 };
const sourceVerificationLabel = (source) => {
  if (!source) return 'טרם נבדק';
  if (source.verificationStatus && source.verificationStatus !== 'unverified') {
    return verificationLabels[source.verificationStatus] || source.verificationStatus;
  }
  return healthLabels[source.health] || 'טרם נבדק';
};
const primarySource = (company) => {
  const sources = Array.isArray(company.sources) ? company.sources : [];
  return sources.find((source) => source.enabled && source.provider !== 'unsupported') ||
    sources.find((source) => source.provider !== 'unsupported') || sources[0] || null;
};

function showFeedback(message, isError = false) {
  elements.feedback.textContent = message;
  elements.feedback.dataset.state = isError ? 'error' : 'success';
}

function stateReason(company, source) {
  if (!source) return 'עדיין לא נמצא עמוד קריירה שאפשר לבדוק.';
  if (source.lastErrorReason) return source.lastErrorReason;
  if (source.verificationStatus === 'verified_jobs') return `המקור אומת ונמצאו בו ${Number(source.lastJobCount || 0)} משרות.`;
  if (source.verificationStatus === 'verified_empty') return 'המקור אומת בהצלחה, אך אין בו כרגע משרות פתוחות.';
  if (source.verificationStatus === 'blocked') return 'האתר חוסם סריקה רגילה; יהיה צורך בבדיקת דפדפן.';
  if (source.verificationStatus === 'needs_adapter') return 'נמצא עמוד קריירה, אך עדיין חסר מתאם למבנה שלו.';
  if (source.provider === 'unsupported') return 'הקישור נשמר, אבל עדיין אין לסורק מתאם לאתר הזה.';
  if (company.status === 'candidate') return 'נמצא מקור שניתן לסרוק; נדרש אישור שלך לפני שמתחילים לעקוב.';
  if (company.status === 'paused' && !source.enabled) return 'המקור הושבת כי לא עבר אימות; צריך לעדכן או לאמת את קישור הקריירה.';
  if (company.status === 'paused') return 'המעקב הושהה. אפשר להחזיר את החברה למעקב בכל רגע.';
  if (company.status === 'ignored') return 'סימנת שהחברה אינה רלוונטית כרגע.';
  if (source.health === 'failed') return `הסריקה האחרונה נכשלה${source.lastErrorCode ? `: ${source.lastErrorCode}` : ''}.`;
  if (source.health === 'healthy') return 'המקור נסרק בהצלחה בריצה האחרונה.';
  return 'החברה פעילה ותיכלל בסריקת ה־ATS הבאה.';
}

function visibleCompanies() {
  const query = elements.listSearch.value.trim().toLocaleLowerCase('he');
  return companies
    .filter((company) => activeStatus === 'all' || company.status === activeStatus)
    .filter((company) => {
      if (!query) return true;
      const source = primarySource(company);
      return `${company.name} ${source?.provider || ''}`.toLocaleLowerCase('he').includes(query);
    })
    .sort((left, right) => (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9) || left.name.localeCompare(right.name));
}

function renderCompanies() {
  const visible = visibleCompanies();
  elements.empty.hidden = visible.length > 0;
  elements.watched.textContent = Number(companyStats.watched ?? 0);
  elements.candidate.textContent = Number(companyStats.candidate ?? 0);
  elements.paused.textContent = Number(companyStats.paused ?? 0);
  elements.body.innerHTML = visible.map((company) => {
    const source = primarySource(company);
    const canWatch = source?.enabled && source.provider !== 'unsupported' && company.status !== 'watched';
    return `<tr><td><strong>${escapeHtml(company.name)}</strong><small>${escapeHtml(company.discoverySource || '')}</small></td>
      <td>${source ? `<a href="${escapeHtml(source.careersUrl)}" target="_blank" rel="noreferrer">${escapeHtml(providerLabels[source.provider] || source.provider)}</a>` : 'לא זוהה'}</td>
      <td><span class="company-status" data-state="${escapeHtml(company.status)}">${escapeHtml(statusLabels[company.status] || company.status)}</span></td>
      <td class="company-reason"><strong>${escapeHtml(sourceVerificationLabel(source))}</strong><span>${escapeHtml(stateReason(company, source))}</span></td>
      <td><div class="company-actions">${canWatch ? `<button type="button" data-company-action="watch" data-company-id="${Number(company.id)}">אשר והוסף למעקב</button>` : ''}${company.status === 'watched' ? `<button type="button" data-company-action="paused" data-company-id="${Number(company.id)}">השהה</button>` : ''}${company.status !== 'ignored' ? `<button type="button" data-company-action="ignored" data-company-id="${Number(company.id)}">לא רלוונטי</button>` : ''}</div></td></tr>`;
  }).join('');
}

async function loadCompanies() {
  try {
    const result = await requestJson('/api/companies');
    companies = result.companies || [];
    companyStats = result.stats || {};
    renderCompanies();
    elements.updated.textContent = `עודכן ${formatTime(Date.now())}`;
  } catch (error) { setSystemStatus('error', error.message); }
}

function renderPreview(candidate, sources, research = null, resolvedSource = null, probe = null) {
  const source = resolvedSource || (Array.isArray(sources) ? primarySource({ sources }) : primarySource(candidate));
  const scannable = source?.enabled && source.provider !== 'unsupported';
  const watched = candidate.status === 'watched';
  const evidence = Array.isArray(research?.evidenceUrls) ? research.evidenceUrls : [];
  const samples = Array.isArray(probe?.samples) ? probe.samples.slice(0, 3) : [];
  const probeSummary = probe
    ? `<p class="company-probe" data-state="${escapeHtml(probe.status || 'unknown')}"><strong>${escapeHtml(verificationLabels[probe.status] || 'תוצאת אימות')}</strong> — ${escapeHtml(probe.reason || '')}</p>`
    : '';
  const sampleLinks = samples.length
    ? `<ul class="company-probe-samples">${samples.map((sample) => `<li><a href="${escapeHtml(sample.url)}" target="_blank" rel="noreferrer">${escapeHtml(sample.title || 'פתח משרה')}</a></li>`).join('')}</ul>`
    : '';
  elements.preview.hidden = false;
  elements.preview.innerHTML = `<div><strong>${escapeHtml(candidate.name)}</strong><span>${watched ? 'החברה כבר נמצאת במעקב.' : scannable ? `זוהה ${escapeHtml(source.provider)} והמקור עבר אימות.` : 'נמצא מקור אפשרי, אך הוא עדיין לא מוכן לסריקה יומית.'}</span>${probeSummary}${sampleLinks}${source ? `<a class="company-preview-link" href="${escapeHtml(source.careersUrl)}" target="_blank" rel="noreferrer">פתח את מקור המשרות</a>` : ''}${research?.rationale ? `<p>${escapeHtml(research.rationale)}</p>` : ''}${evidence.length ? `<small>מקורות אימות: ${evidence.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${index + 1}</a>`).join(' · ')}</small>` : ''}</div>${scannable && !watched ? `<button class="button button-primary" type="button" data-company-action="watch" data-company-id="${Number(candidate.id)}">אשר והוסף למעקב</button>` : ''}`;
}

async function updateCompany(companyId, action) {
  const watch = action === 'watch';
  await postJson(`/api/companies/${encodeURIComponent(companyId)}/${watch ? 'watch' : 'status'}`, watch ? {} : { status: action });
  elements.preview.hidden = true;
  showFeedback(watch ? 'החברה נוספה למעקב ותיכלל בסריקת ATS הבאה.' : 'מצב החברה עודכן.');
  await loadCompanies();
  window.dispatchEvent(new Event('jobops:refresh-summary'));
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = elements.form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await postJson('/api/companies/resolve', { name: elements.name.value, url: elements.url.value });
    renderPreview(result.candidate, result.sources, null, result.resolvedSource);
    showFeedback(result.candidate.status === 'watched' ? 'החברה כבר נמצאת במעקב.' : 'הבדיקה הסתיימה. נדרש אישור לפני הוספה למעקב.');
    await loadCompanies();
  } catch (error) { showFeedback(error.message, true); }
  finally { submit.disabled = false; }
});

elements.researchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = elements.researchForm.querySelector('button[type="submit"]');
  const originalLabel = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'מחפש ומאמת…';
  showFeedback('מחפש עמוד קריירה רשמי או אתר גיוס ייעודי. זה עשוי לקחת עד דקה.');
  try {
    const result = await postJson('/api/companies/research', { name: elements.researchName.value });
    renderPreview(result.candidate, result.sources, result.research, result.resolvedSource, result.probe);
    showFeedback(result.probe?.status === 'verified_jobs' || result.probe?.status === 'verified_empty'
      ? 'המחקר והאימות הסתיימו. המקור נשמר כמועמד בלבד; נדרש אישור לפני הוספה למעקב.'
      : 'המחקר הסתיים, אך המקור עדיין אינו מוכן למעקב. הסיבה מוצגת למטה.');
    await loadCompanies();
  } catch (error) { showFeedback(error.message, true); }
  finally { submit.disabled = false; submit.textContent = originalLabel; }
});

async function handleAction(event) {
  const button = event.target.closest('[data-company-action]');
  if (!button) return;
  button.disabled = true;
  try { await updateCompany(button.dataset.companyId, button.dataset.companyAction); }
  catch (error) { button.disabled = false; showFeedback(error.message, true); }
}

elements.listSearch.addEventListener('input', renderCompanies);
elements.statusFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-status-filter]');
  if (!button) return;
  activeStatus = button.dataset.statusFilter;
  for (const item of elements.statusFilters.querySelectorAll('[data-status-filter]')) {
    item.setAttribute('aria-pressed', String(item === button));
  }
  renderCompanies();
});
elements.body.addEventListener('click', handleAction);
elements.preview.addEventListener('click', handleAction);
await loadCompanies();
