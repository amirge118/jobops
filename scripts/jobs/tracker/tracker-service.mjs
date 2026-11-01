import { normalizeCompanyRole } from '../core.mjs';
import { exportDocument, fileHasDrifted, markFileExported, readDocumentFile } from '../candidate/file-sync.mjs';
import { cleanCell, parseTracker, renderTracker, TRACKER_STATUSES } from './format.mjs';

const KIND = 'applications';
const MAX_NOTES_CHARS = 2_000;
// Statuses at or past "Applied": a new "applied" decision never moves these back.
const AT_OR_PAST_APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'rejected']);

function failure(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

// One row per company and role (hard rule 4). Rows live in the database, and
// data/applications.md stays a copy for the skills that read it.
export function createTrackerService({ store, config, userId }) {
  const sync = { store, config, userId };

  // A user's file is taken in once, on first use.
  async function ensureImported() {
    if (config.demo || await store.getProfileFileExport(userId, KIND)) return;
    const content = readDocumentFile(config, KIND);
    if (content === null) return;
    await store.replaceApplications(userId, parseTracker(content));
    await markFileExported(sync, KIND, content);
  }

  async function publish() {
    return await exportDocument(sync, { kind: KIND, content: renderTracker(await store.listApplications(userId)) });
  }

  async function addRow({ company, role, score, status, date, notes }) {
    const number = await store.nextApplicationNumber(userId);
    const companyName = cleanCell(company) || 'Unknown';
    const roleName = cleanCell(role) || 'Unknown';
    await store.saveApplication(userId, {
      number, numberLabel: String(number).padStart(3, '0'), date, company: companyName, role: roleName,
      companyRoleKey: normalizeCompanyRole(companyName, roleName), score, status, pdf: '❌', report: '—', notes: cleanCell(notes),
    });
    return number;
  }

  return {
    async list() {
      await ensureImported();
      return {
        rows: await store.listApplications(userId),
        statuses: TRACKER_STATUSES,
        fileDrift: await fileHasDrifted(sync, KIND),
      };
    },

    async markdown() {
      await ensureImported();
      return renderTracker(await store.listApplications(userId));
    },

    // The dashboard's "applied" decision.
    async recordApplied({ company, title, score, date, applyUrl }) {
      await ensureImported();
      const note = `Applied ${date} (dashboard).`;
      const scoreText = Number.isFinite(Number(score)) && score !== null ? `${Number(score).toFixed(1)}/5` : 'N/A';
      const identity = normalizeCompanyRole(company, title);
      const existing = identity === '::' ? null : await store.findApplicationByIdentity(userId, identity);
      if (existing && AT_OR_PAST_APPLIED.has(existing.status.toLowerCase())) return { action: 'unchanged', number: existing.numberLabel };
      if (existing) {
        await store.saveApplication(userId, { ...existing, status: 'Applied', notes: cleanCell([existing.notes, note].filter(Boolean).join(' ')) });
        await publish();
        return { action: 'updated', number: existing.numberLabel };
      }
      const number = await addRow({ company, role: title, score: scoreText, status: 'Applied', date, notes: `${note} ${applyUrl || ''}` });
      await publish();
      return { action: 'added', number: String(number).padStart(3, '0') };
    },

    async add({ company, role, status = 'Evaluated', date, notes = '' }) {
      await ensureImported();
      if (!cleanCell(company) || !cleanCell(role)) throw failure(400, 'invalid_application', 'יש למלא חברה ותפקיד');
      if (!TRACKER_STATUSES.includes(status)) throw failure(400, 'invalid_status', 'סטטוס לא מוכר');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw failure(400, 'invalid_date', 'תאריך לא תקין');
      const existing = await store.findApplicationByIdentity(userId, normalizeCompanyRole(cleanCell(company), cleanCell(role)));
      if (existing) throw failure(409, 'application_exists', `כבר קיימת שורה לחברה ולתפקיד האלה (${existing.numberLabel})`);
      const number = await addRow({ company, role, score: 'N/A', status, date, notes });
      return { row: await store.getApplication(userId, number), fileCopy: await publish() };
    },

    async update(number, { status, notes }) {
      await ensureImported();
      const row = await store.getApplication(userId, number);
      if (!row) throw failure(404, 'application_not_found', 'השורה לא נמצאה');
      if (status !== undefined && !TRACKER_STATUSES.includes(status)) throw failure(400, 'invalid_status', 'סטטוס לא מוכר');
      if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES_CHARS)) throw failure(400, 'invalid_notes', 'ההערה ארוכה מדי');
      await store.saveApplication(userId, { ...row, ...(status !== undefined ? { status } : {}), ...(notes !== undefined ? { notes: cleanCell(notes) } : {}) });
      return { row: await store.getApplication(userId, number), fileCopy: await publish() };
    },

    // Takes in a file a skill or a person edited. Its rows replace the list.
    async adoptFile() {
      const content = readDocumentFile(config, KIND);
      if (content === null) throw failure(404, 'file_not_found', 'לא נמצא קובץ לקליטה');
      const rows = parseTracker(content);
      await store.replaceApplications(userId, rows);
      await markFileExported(sync, KIND, content);
      return { rows: rows.length };
    },
  };
}
