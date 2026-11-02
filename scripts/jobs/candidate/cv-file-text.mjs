const RTL_LETTERS = /[\p{Script=Hebrew}\p{Script=Arabic}]/gu;
const LATIN_LETTERS = /\p{Script=Latin}/gu;

// A PDF stores a line's pieces in drawing order. In a right-to-left line that
// mixes in English or numbers, reading order is their position from the right.
function lineText(pieces) {
  const text = pieces.map((item) => item.str ?? '').join('');
  const rtl = text.match(RTL_LETTERS)?.length ?? 0;
  if (rtl <= (text.match(LATIN_LETTERS)?.length ?? 0)) return text;
  return [...pieces].sort((left, right) => right.transform[4] - left.transform[4]).map((item) => item.str ?? '').join('');
}

export function pageText(items) {
  const lines = [];
  let line = [];
  for (const item of items) {
    line.push(item);
    if (item.hasEOL) {
      lines.push(lineText(line));
      line = [];
    }
  }
  if (line.length) lines.push(lineText(line));
  return lines.join('\n');
}
