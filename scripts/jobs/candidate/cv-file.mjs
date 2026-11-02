import { createHash } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 20;
const MIN_CHARS = 50;
const MAX_CHARS = 40_000;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_NAME_CHARS = 120;
const EXTRACT_TIMEOUT_MS = 30_000;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

const TYPES = {
  pdf: { mimeType: 'application/pdf', extension: '.pdf' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' },
};

const FAILURES = {
  unsupported: [415, 'cv_file_unsupported', 'אפשר להעלות רק קובץ PDF או Word מסוג docx.'],
  legacy_doc: [415, 'cv_file_legacy_doc', 'קובץ doc ישן לא נתמך. יש לשמור אותו כ-docx או כ-PDF ולהעלות שוב.'],
  too_large: [413, 'cv_file_too_large', 'הקובץ גדול מ-10MB.'],
  too_many_pages: [413, 'cv_file_too_many_pages', 'הקובץ ארוך מ-20 עמודים, וזה יותר מדי לקורות חיים.'],
  too_long: [413, 'cv_file_too_long', 'הטקסט בקובץ ארוך מדי לקורות חיים.'],
  no_text: [422, 'cv_file_no_text', 'לא נמצא טקסט בקובץ, כנראה שהוא סרוק. אפשר להדביק את הטקסט בחלק "הטקסט שהמערכת קראה".'],
  encrypted: [422, 'cv_file_encrypted', 'הקובץ מוגן בסיסמה. יש להסיר את ההגנה ולהעלות שוב.'],
  corrupt: [422, 'cv_file_corrupt', 'לא הצלחנו לקרוא את הקובץ. ייתכן שהוא פגום.'],
};

function refuse(reason) {
  const [statusCode, code, message] = FAILURES[reason];
  return Object.assign(new Error(message), { statusCode, code });
}

function startsWith(bytes, signature) {
  return bytes.subarray(0, signature.length).equals(signature);
}

// Reads a ZIP's table of contents without unpacking anything: a Word file must
// hold its document, and a small file that unpacks to gigabytes is refused here.
function checkDocxPackage(bytes) {
  const minimumEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let end = -1;
  for (let at = bytes.length - 22; at >= minimumEnd; at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw refuse('corrupt');
  const entries = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  let unpacked = 0;
  let hasDocument = false;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw refuse('corrupt');
    unpacked += bytes.readUInt32LE(at + 24);
    if (unpacked > MAX_UNPACKED_BYTES) throw refuse('too_large');
    const nameLength = bytes.readUInt16LE(at + 28);
    if (bytes.toString('utf8', at + 46, at + 46 + nameLength) === 'word/document.xml') hasDocument = true;
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (!hasDocument) throw refuse('unsupported');
}

// The file's own first bytes decide its type, never its name.
export function detectFileType(bytes) {
  if (startsWith(bytes, Buffer.from('%PDF-'))) return 'pdf';
  if (startsWith(bytes, Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'docx';
  if (startsWith(bytes, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) throw refuse('legacy_doc');
  throw refuse('unsupported');
}

function readInWorker(type, bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cv-file-worker.mjs', import.meta.url), {
      workerData: { type, bytes: new Uint8Array(bytes), maxPages: MAX_PAGES }, resourceLimits: WORKER_LIMITS,
    });
    const timer = setTimeout(() => { worker.terminate(); reject(refuse('corrupt')); }, EXTRACT_TIMEOUT_MS);
    const finish = (settle, value) => { clearTimeout(timer); worker.terminate(); settle(value); };
    worker.once('message', ({ text, reason }) => (reason ? finish(reject, refuse(reason)) : finish(resolve, text)));
    worker.once('error', () => finish(reject, refuse('corrupt')));
    worker.once('exit', () => finish(reject, refuse('corrupt')));
  });
}

export function safeFileName(name, type) {
  const { extension } = TYPES[type];
  const base = path.basename(String(name ?? '').replaceAll('\\', '/')).replace(/\.[^.]*$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, MAX_NAME_CHARS);
  return `${base || 'cv'}${extension}`;
}

export function decodeFile(contentBase64) {
  if (typeof contentBase64 !== 'string' || !contentBase64) throw refuse('unsupported');
  if (Math.floor(contentBase64.length * 3 / 4) > MAX_FILE_BYTES + 2) throw refuse('too_large');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length > MAX_FILE_BYTES) throw refuse('too_large');
  return bytes;
}

// Local and without AI: the file itself is never sent anywhere.
export async function extractCvFile(bytes, fileName) {
  const type = detectFileType(bytes);
  if (type === 'docx') checkDocxPackage(bytes);
  const text = (await readInWorker(type, bytes)).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < MIN_CHARS) throw refuse('no_text');
  if (text.length > MAX_CHARS) throw refuse('too_long');
  return {
    text,
    fileName: safeFileName(fileName, type),
    mimeType: TYPES[type].mimeType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    content: bytes,
  };
}

const wordsOf = (text) => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const missingFrom = (words, other) => [...words].filter((word) => !other.has(word));
const withinDrift = (missing, words) => missing.length <= Math.max(MIN_WORD_DRIFT, words.size * MAX_WORD_DRIFT);
const MIN_WORD_DRIFT = 3;
const MAX_WORD_DRIFT = 0.03;

// Hard rule 1 for text that is saved without a review: if the AI's organized
// copy added words or lost words, the file's own text is used instead. A few
// words can be a heading it added, but a number it added never is.
export function organizedTextIsFaithful(source, organized) {
  const sourceWords = wordsOf(source);
  const organizedWords = wordsOf(organized);
  const added = missingFrom(organizedWords, sourceWords);
  return withinDrift(added, organizedWords) && !added.some((word) => /\p{N}/u.test(word))
    && withinDrift(missingFrom(sourceWords, organizedWords), sourceWords);
}
