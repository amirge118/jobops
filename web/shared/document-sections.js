// The browser's copy of scripts/jobs/profile/document-sections.mjs; a test keeps them equal.

export function splitSections(markdown) {
  const lines = String(markdown ?? '').split(/(?<=\n)/);
  const parsed = { preamble: '', sections: [] };
  for (const line of lines) {
    if (/^## /.test(line)) parsed.sections.push({ heading: line, body: '' });
    else if (parsed.sections.length) parsed.sections.at(-1).body += line;
    else parsed.preamble += line;
  }
  return parsed;
}

export function joinSections({ preamble, sections }) {
  return preamble + sections.map(({ heading, body }) => heading + body).join('');
}

export function headingText(heading) {
  return heading.replace(/^##\s+/, '').trim();
}
