#!/usr/bin/env node

/**
 * check-competency-rows.mjs — detect orphaned "Core Competencies" tag rows
 *
 * The competencies section (templates/cv-template.html, .competencies-grid /
 * .competency-tag) is a plain flex-wrap row. Tag text length varies a lot, so
 * nothing guarantees the last row fills up — it can end up with just 1-2 tags
 * dangling alone under a full first row. Char-count heuristics aren't reliable
 * (font metrics vary), so this renders the actual HTML in headless Chromium at
 * the same effective width Playwright uses for the real PDF (see
 * generate-pdf.mjs: page.pdf({format, margin: 0.6in each side})) and measures
 * where each .competency-tag actually lands.
 *
 * Usage:
 *   node scripts/check-competency-rows.mjs <cv.html> [--format=a4|letter]
 *
 * Exit code 0 + "OK" if every row is reasonably full, 1 + "ORPHANED: ..." if
 * the last row is sparse compared to the rest.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Effective content width at 96dpi for A4/Letter with the 0.6in margins
// generate-pdf.mjs applies on every side. This is the real wrap constraint —
// NOT the template's own `.page { max-width: 800px }`, which is wider than
// the printed page and never binds once Playwright paginates to a paper size.
const CONTENT_WIDTH_PX = {
  a4: Math.round((8.2677 - 1.2) * 96),   // ≈ 679px
  letter: Math.round((8.5 - 1.2) * 96),  // ≈ 701px
};

async function checkCompetencyRows() {
  const args = process.argv.slice(2);
  let inputPath, format = 'a4';

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (!inputPath) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    console.error('Usage: node check-competency-rows.mjs <cv.html> [--format=a4|letter]');
    process.exit(1);
  }

  if (!CONTENT_WIDTH_PX[format]) {
    console.error(`Invalid format "${format}". Use: ${Object.keys(CONTENT_WIDTH_PX).join(', ')}`);
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  const width = CONTENT_WIDTH_PX[format];

  // Resolve font paths the same way generate-pdf.mjs does, so measured tag
  // widths match what actually renders in the PDF.
  let html = await readFile(inputPath, 'utf-8');
  const fontsDir = resolve(__dirname, 'fonts');
  html = html.replace(/url\(['"]?\.\/fonts\//g, `url('file://${fontsDir}/`);
  html = html.replace(/file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g, `file://$1.$2')`);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height: 2000 });
    await page.setContent(html, {
      waitUntil: 'networkidle',
      baseURL: `file://${dirname(inputPath)}/`,
    });
    await page.evaluate(() => document.fonts.ready);

    const tags = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.competency-tag')).map((el) => ({
        text: el.textContent.trim(),
        top: Math.round(el.getBoundingClientRect().top),
      }));
    });

    if (tags.length === 0) {
      console.log('No .competency-tag elements found — nothing to check.');
      process.exit(0);
    }

    // Group into rows: tags within 2px of top are the same row.
    const rows = [];
    for (const tag of tags) {
      let row = rows.find((r) => Math.abs(r.top - tag.top) <= 2);
      if (!row) {
        row = { top: tag.top, tags: [] };
        rows.push(row);
      }
      row.tags.push(tag.text);
    }
    rows.sort((a, b) => a.top - b.top);

    console.log(`📐 ${inputPath}`);
    console.log(`📏 Content width: ${width}px (${format.toUpperCase()})`);
    rows.forEach((row, i) => {
      console.log(`   Row ${i + 1}: ${row.tags.length} tags — ${row.tags.join(', ')}`);
    });

    if (rows.length < 2) {
      console.log('✅ OK — single row, nothing to orphan.');
      process.exit(0);
    }

    const maxCount = Math.max(...rows.map((r) => r.tags.length));
    const lastCount = rows[rows.length - 1].tags.length;
    const orphaned = lastCount <= 2 ? maxCount >= 4 : lastCount * 2 <= maxCount;

    if (orphaned) {
      console.log(`❌ ORPHANED: last row has only ${lastCount} tag(s) vs. the fullest row's ${maxCount}.`);
      process.exit(1);
    }

    console.log('✅ OK — rows are reasonably balanced.');
    process.exit(0);
  } finally {
    await browser.close();
  }
}

checkCompetencyRows().catch((err) => {
  console.error('❌ Check failed:', err.message);
  process.exit(1);
});
