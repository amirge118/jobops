import path from 'node:path';

const SOURCES = new Set(['all', 'ats', 'whatsapp']);

export function parseDashboardOptions(input = {}, maxLookbackDays = 14) {
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > Number(maxLookbackDays)) {
    throw new Error(`days must be an integer between 1 and ${maxLookbackDays}`);
  }

  const source = String(input.source || 'all');
  if (!SOURCES.has(source)) throw new Error('source must be all, ats, or whatsapp');

  return { days, source, open: input.open === true };
}

export function buildActionCommand(action, options, rootDir) {
  if (action === 'scan') {
    const args = [path.join(rootDir, 'scripts', 'jobs.mjs'), '--days', String(options.days)];
    if (options.source === 'ats') args.push('--ats-only');
    if (options.source === 'whatsapp') args.push('--whatsapp-only');
    if (options.open) args.push('--open');
    return { command: process.execPath, args };
  }
  if (action === 'verify-groups') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'scripts', 'jobs', 'verify-groups.mjs')],
    };
  }
  if (action === 'open-jobs') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'scripts', 'jobs', 'open.mjs')],
    };
  }
  if (action === 'retry-failed') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'scripts', 'jobs.mjs'), '--retry-only'],
    };
  }
  if (action === 'mark-read') {
    return {
      command: process.execPath,
      args: [path.join(rootDir, 'scripts', 'jobs', 'mark-groups-read.mjs')],
    };
  }
  throw new Error(`Unknown action: ${action}`);
}

export function actionLabel(action) {
  return {
    scan: 'סריקת משרות',
    'verify-groups': 'אימות קבוצות WhatsApp',
    'open-jobs': 'פתיחת משרות ב-Chrome',
    'retry-failed': 'ניסיון חוזר לקישורים שנכשלו',
    'mark-read': 'סימון קבוצות WhatsApp כנקראו',
  }[action] || action;
}
