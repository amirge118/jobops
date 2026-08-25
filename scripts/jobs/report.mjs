function cleanCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toISOString();
}

export function renderMinimalReport({ generatedAt = new Date(), window, jobs = [] }) {
  const sorted = [...jobs].sort((left, right) => Number(right.score) - Number(left.score));
  const lines = [
    `# דוח משרות — ${formatTimestamp(generatedAt).slice(0, 10)}`,
    '',
    `טווח סריקה: ${formatTimestamp(window?.from)} עד ${formatTimestamp(window?.to)}`,
    '',
  ];

  if (sorted.length === 0) {
    lines.push('לא נמצאו משרות חדשות מתאימות.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('| חברה | תיאור משרה קצר | ציון | התאמה | סיבת ההחלטה | URL |');
  lines.push('|---|---|---:|---|---|---|');
  for (const job of sorted) {
    lines.push(
      `| ${cleanCell(job.company)} | ${cleanCell(job.summary || job.title)} | ${Number(job.score).toFixed(1)} | ${cleanCell(job.fitLabel)} | ${cleanCell(job.decisionReason)} | [הגשה](${job.applyUrl}) |`,
    );
  }

  return `${lines.join('\n')}\n`;
}
