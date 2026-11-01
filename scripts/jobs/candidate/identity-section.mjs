import { findSection, joinSections, splitSections } from './document-sections.mjs';

// Contact details are fields in the page, and lines of the profile's Identity
// section underneath, so there is one place they live. Other lines are kept.
export const IDENTITY_FIELDS = Object.freeze({
  name: 'Name', location: 'Location', phone: 'Phone', email: 'Email',
  linkedin: 'LinkedIn', github: 'GitHub', languages: 'Languages', status: 'Status',
});
const SECTION = 'Identity';
const MAX_VALUE_CHARS = 200;

const lineFor = (label, value) => `- **${label}:** ${value}\n`;
const lineMatcher = (label) => new RegExp(`^- \\*\\*${label}:\\*\\*[ \\t]*(.*)$`, 'mi');

export function parseIdentity(markdown) {
  const body = findSection(splitSections(markdown), SECTION)?.body ?? '';
  return Object.fromEntries(Object.entries(IDENTITY_FIELDS).map(([key, label]) => [key, body.match(lineMatcher(label))?.[1]?.trim() ?? '']));
}

export function validateIdentityFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Identity must be an object');
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(IDENTITY_FIELDS, key)) throw new Error(`Unknown identity field: ${key}`);
    if (typeof value !== 'string') throw new Error(`${key} must be text`);
    if (value.length > MAX_VALUE_CHARS || /[\r\n]/.test(value)) throw new Error(`${key} must be one line of up to ${MAX_VALUE_CHARS} characters`);
  }
}

function updatedBody(body, fields) {
  let next = body;
  for (const [key, raw] of Object.entries(fields)) {
    const label = IDENTITY_FIELDS[key];
    const value = raw.trim();
    const matcher = lineMatcher(label);
    if (matcher.test(next)) next = next.replace(new RegExp(`${matcher.source}\\n?`, 'mi'), () => (value ? lineFor(label, value) : ''));
    else if (value) next = next.replace(/\n*$/, (end) => `${next.trim() ? '\n' : ''}${lineFor(label, value)}${end.length > 1 ? '\n' : ''}`);
  }
  return next;
}

export function applyIdentity(markdown, fields) {
  validateIdentityFields(fields);
  const parsed = splitSections(markdown);
  const section = findSection(parsed, SECTION);
  if (section) section.body = updatedBody(section.body, fields);
  else parsed.sections.unshift({ heading: `## ${SECTION}\n`, body: `${updatedBody('', fields)}\n` });
  return joinSections(parsed);
}
