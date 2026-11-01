// A document is plain Markdown; sections are only a view of it. Splitting and
// joining always give back the exact text, so viewing never changes a document.

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

export function findSection(parsed, name) {
  const wanted = name.toLowerCase();
  return parsed.sections.find((section) => headingText(section.heading).toLowerCase() === wanted) ?? null;
}

export function withoutSection(markdown, name) {
  const parsed = splitSections(markdown);
  return joinSections({ preamble: parsed.preamble, sections: parsed.sections.filter((section) => section !== findSection(parsed, name)) });
}
