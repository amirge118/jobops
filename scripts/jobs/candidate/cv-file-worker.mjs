// Reads text out of an uploaded file. A hostile or broken file runs here, in its
// own thread with memory and time limits, and not in the dashboard's server.

import { parentPort, workerData } from 'node:worker_threads';

import { pageText } from './cv-file-text.mjs';

async function pdfText(bytes, maxPages) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  if (document.numPages > maxPages) throw Object.assign(new Error('Too many pages'), { reason: 'too_many_pages' });
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const { items } = await page.getTextContent();
    pages.push(pageText(items));
  }
  return pages.join('\n\n');
}

async function docxText(bytes) {
  const { default: mammoth } = await import('mammoth');
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

try {
  const { type, bytes, maxPages } = workerData;
  parentPort.postMessage({ text: type === 'pdf' ? await pdfText(bytes, maxPages) : await docxText(bytes) });
} catch (error) {
  parentPort.postMessage({ reason: error.reason || (error.name === 'PasswordException' ? 'encrypted' : 'corrupt') });
}
