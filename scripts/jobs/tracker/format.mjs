import fs from 'node:fs';

import { load as parseYaml } from 'js-yaml';

import { normalizeCompanyRole } from '../core.mjs';

// templates/states.yml is the one list of statuses, as hard rule 4 requires.
export const TRACKER_STATUSES = Object.freeze(parseYaml(fs.readFileSync(new URL('../../../templates/states.yml', import.meta.url), 'utf8')).states.map((state) => state.label));

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];

export function cleanCell(value) {
  return String(value ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseTracker(markdown) {
  const rows = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 9 || !/^\d+$/.test(cells[0])) continue;
    const [numberLabel, date, company, role, score, status, pdf, report, ...notes] = cells;
    rows.push({
      number: Number(numberLabel), numberLabel, date, company, role, score, status, pdf, report,
      notes: notes.join(' | '), companyRoleKey: normalizeCompanyRole(company, role),
    });
  }
  return rows;
}

export function renderTracker(rows) {
  const lines = rows.map((row) => `| ${[row.numberLabel, row.date, row.company, row.role, row.score, row.status, row.pdf, row.report, row.notes].join(' | ')} |`);
  return `${[...HEADER, ...lines].join('\n')}\n`;
}
