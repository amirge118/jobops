// "הגשתי" on the Decisions page records the application in data/applications.md.
// Tracker rules (CLAUDE.md): one row per company+role, canonical status only,
// dates and free text in their own columns.

import fs from 'node:fs';
import path from 'node:path';

import { normalizeCompanyRole } from './core.mjs';

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];
// Statuses at or past "Applied" in templates/states.yml: never moved backwards.
const AT_OR_PAST_APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'rejected']);

function cell(value) {
  return String(value ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitRow(line) {
  return line.split('|').slice(1, -1).map((part) => part.trim());
}

function joinRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

// Pure: returns the new tracker text and what happened.
// action: 'added' | 'updated' | 'unchanged'.
export function recordApplication(markdown, { company, title, score, date, applyUrl }) {
  const lines = String(markdown || '').trim() ? String(markdown).replace(/\n+$/, '').split('\n') : [...HEADER];
  const identity = normalizeCompanyRole(company, title);
  const note = `Applied ${date} (dashboard).`;
  let lastRow = -1;
  let maxNumber = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitRow(lines[index]);
    if (cells.length < 9 || !/^\d+$/.test(cells[0])) continue;
    lastRow = index;
    maxNumber = Math.max(maxNumber, Number(cells[0]));
    if (identity === '::' || normalizeCompanyRole(cells[2], cells[3]) !== identity) continue;
    if (AT_OR_PAST_APPLIED.has(cells[5].toLowerCase())) return { markdown, action: 'unchanged', number: cells[0] };
    cells[5] = 'Applied';
    cells[8] = [cells[8], note].filter(Boolean).join(' ');
    lines[index] = joinRow(cells);
    return { markdown: `${lines.join('\n')}\n`, action: 'updated', number: cells[0] };
  }

  const number = String(maxNumber + 1).padStart(3, '0');
  const row = joinRow([
    number, date, cell(company) || 'Unknown', cell(title) || 'Unknown',
    Number.isFinite(Number(score)) && score !== null ? `${Number(score).toFixed(1)}/5` : 'N/A',
    'Applied', '❌', '—', cell(`${note} ${applyUrl || ''}`),
  ]);
  // After the last row, or right under the header separator of an empty table.
  const separator = lines.findIndex((line) => /^\|\s*-/.test(line));
  lines.splice(lastRow >= 0 ? lastRow + 1 : separator >= 0 ? separator + 1 : lines.length, 0, row);
  return { markdown: `${lines.join('\n')}\n`, action: 'added', number };
}

export function recordApplicationInTracker(rootDir, entry) {
  const file = path.join(rootDir, 'data', 'applications.md');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const result = recordApplication(current, entry);
  if (result.action !== 'unchanged') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, result.markdown);
    fs.renameSync(temp, file);
  }
  return { action: result.action, number: result.number };
}
