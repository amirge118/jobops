import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMinimalReport } from '../scripts/jobs/report.mjs';

test('minimal report contains only the requested job columns', () => {
  const markdown = renderMinimalReport({
    generatedAt: new Date('2026-08-24T09:00:00Z'),
    window: { from: '2026-08-22T09:00:00Z', to: '2026-08-24T09:00:00Z' },
    jobs: [{
      company: 'Obligo',
      title: 'Data Engineer',
      summary: 'בניית תשתיות ופייפלייני דאטה.',
      score: 4.7,
      fitLabel: 'בול מתאים',
      decisionReason: 'התאמה חזקה ל-Backend, AWS ו-SQL.',
      applyUrl: 'https://example.com/jobs/123',
    }],
  });

  assert.match(markdown, /\| חברה \| תיאור משרה קצר \| ציון \| התאמה \| סיבת ההחלטה \| URL \|/);
  assert.match(markdown, /Obligo/);
  assert.match(markdown, /4\.7/);
  assert.match(markdown, /\[הגשה\]\(https:\/\/example\.com\/jobs\/123\)/);
  assert.doesNotMatch(markdown, /דרישות חובה|סניוריטי|קבוצת מקור|פירוט ניקוד/);
});

test('minimal report handles an empty run clearly', () => {
  const markdown = renderMinimalReport({
    generatedAt: new Date('2026-08-24T09:00:00Z'),
    window: { from: '2026-08-22T09:00:00Z', to: '2026-08-24T09:00:00Z' },
    jobs: [],
  });

  assert.match(markdown, /לא נמצאו משרות חדשות מתאימות/);
});
