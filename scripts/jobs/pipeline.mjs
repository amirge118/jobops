import fs from 'node:fs';
import path from 'node:path';

import { canonicalizeJobUrl } from './core.mjs';

function pipelineUrls(content) {
  const seen = new Set();
  for (const match of content.matchAll(/https?:\/\/[^\s|)]+/g)) {
    const canonical = canonicalizeJobUrl(match[0]);
    if (canonical) seen.add(canonical);
  }
  return seen;
}

export function appendMatchingJobs(pipelinePath, jobs) {
  let content = fs.existsSync(pipelinePath)
    ? fs.readFileSync(pipelinePath, 'utf8')
    : '# Pipeline — Inbox of matching job URLs\n\n## Pending\n\n## Done\n';
  const seen = pipelineUrls(content);
  const additions = [];

  for (const job of jobs) {
    const canonical = canonicalizeJobUrl(job.applyUrl);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    additions.push(
      `- [ ] ${job.applyUrl} | ${job.company} | ${job.title} — unified scan, score ${Number(job.score).toFixed(1)}/5`,
    );
  }

  if (additions.length === 0) {
    if (!fs.existsSync(pipelinePath)) {
      fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
      fs.writeFileSync(pipelinePath, content, 'utf8');
    }
    return { added: 0 };
  }

  const marker = '## Pending';
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    content = `${content.trimEnd()}\n\n${marker}\n${additions.join('\n')}\n`;
  } else {
    const insertAt = markerIndex + marker.length;
    content = `${content.slice(0, insertAt)}\n${additions.join('\n')}\n${content.slice(insertAt).trimStart()}`;
  }

  fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
  fs.writeFileSync(pipelinePath, content, 'utf8');
  return { added: additions.length };
}
