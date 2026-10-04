// Aggregates the stored per-job resume-gap analyses (gap_observations) into
// "what is missing for a perfect fit", grouped by the three questions the
// personal area answers: missing tools, experience, and screening keywords.
// Pure: no store or file access, so it is tested directly.

export const GAP_CATEGORIES = ['tool', 'experience', 'keyword'];
const STRONG_FIT_SCORE = 4;
// Jobs you passed on still count as demand, but only faintly, so their gaps
// cannot push the top of the lists.
const LOW_WEIGHT_DECISIONS = new Set(['not_relevant', 'too_senior', 'company_not_interesting']);
const LOW_WEIGHT_FACTOR = 0.25;
const MAX_EXAMPLES = 3;

// "Node.js" / "NodeJS" / "node js" and "CI/CD" / "CICD" must land in one row.
export function termKey(term) {
  return String(term || '').toLowerCase().replace(/[^\p{L}\p{N}+#]/gu, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Short keys ("go", "aws") would match inside unrelated words once spaces are
// stripped, so they need a whole-word match against the original text.
function appearsInResume(term, key, resume) {
  if (!key || !resume.text) return false;
  if (key.length >= 4) return resume.compact.includes(key);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(String(term).toLowerCase().trim())}($|[^\\p{L}\\p{N}])`, 'u')
    .test(resume.text);
}

function mostCommon(counts, fallback) {
  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

export function aggregateGaps(observations, { currentResumeText = '', statuses = [] } = {}) {
  const statusOf = new Map(statuses.map((entry) => [entry.termKey, entry.status]));
  const resume = {
    text: String(currentResumeText).toLowerCase(),
    compact: termKey(currentResumeText),
  };
  const rows = new Map();
  const rowFor = (term) => {
    const key = termKey(term);
    if (!key) return null;
    let row = rows.get(key);
    if (!row) {
      row = {
        key, spellings: new Map(), categories: new Map(), kinds: new Map(), jobWeights: new Map(),
        required: new Set(), interested: new Set(), lowWeight: new Set(), companies: [], coverage: { missing: 0, partial: 0 },
        keyword: null, explanation: null, suggestion: null, evidence: null, note: null,
      };
      rows.set(key, row);
    }
    bump(row.spellings, String(term).trim());
    return row;
  };
  const touchJob = (row, observation, weight) => {
    const lowWeight = LOW_WEIGHT_DECISIONS.has(observation.decision);
    const effective = lowWeight ? weight * LOW_WEIGHT_FACTOR : weight;
    row.jobWeights.set(observation.jobKey, Math.max(row.jobWeights.get(observation.jobKey) || 0, effective));
    if (observation.decision === 'interested') row.interested.add(observation.jobKey);
    if (lowWeight) row.lowWeight.add(observation.jobKey);
    if (observation.company && !row.companies.includes(observation.company) && row.companies.length < MAX_EXAMPLES) {
      row.companies.push(observation.company);
    }
  };

  // Newest first, so the first explanation a row sees is the most recent one.
  const sorted = [...observations].sort((left, right) => Number(right.observedAt || 0) - Number(left.observedAt || 0));
  for (const observation of sorted) {
    const base = (Number(observation.score) >= STRONG_FIT_SCORE ? 1.5 : 1)
      + (observation.decision === 'interested' ? 1 : 0);
    for (const item of observation.analysis?.items || []) {
      const row = rowFor(item.term || item.keyword);
      if (!row) continue;
      const required = item.importance === 'required';
      touchJob(row, observation, base + (required ? 1 : 0));
      if (required) row.required.add(observation.jobKey);
      bump(row.categories, GAP_CATEGORIES.includes(item.category) ? item.category : 'keyword');
      bump(row.kinds, item.kind);
      if (!row.explanation) {
        Object.assign(row, {
          keyword: item.keyword, explanation: item.explanation, suggestion: item.suggestion, evidence: item.evidence || null,
        });
      }
    }
    // A priority the resume already covers strongly is not a gap.
    for (const priority of observation.analysis?.employerPriorities || []) {
      if (priority.coverage !== 'missing' && priority.coverage !== 'partial') continue;
      const row = rowFor(priority.term || priority.priority);
      if (!row) continue;
      const critical = priority.weight === 'critical';
      touchJob(row, observation, base + (critical ? 1 : 0));
      if (critical) row.required.add(observation.jobKey);
      row.coverage[priority.coverage] += 1;
      if (!row.note) row.note = priority.note;
    }
  }

  const sections = Object.fromEntries(GAP_CATEGORIES.map((category) => [category, []]));
  const hidden = [];
  for (const row of rows.values()) {
    const term = mostCommon(row.spellings, row.key);
    // Rows seen only as employer priorities are screening phrases by nature.
    const category = mostCommon(row.categories, 'keyword');
    // One job with profile evidence is enough to make it a wording fix.
    const kind = row.kinds.has('safe_addition') ? 'safe_addition' : mostCommon(row.kinds, null);
    const status = statusOf.get(row.key) || null;
    if (status === 'hidden') {
      hidden.push({ term, category, jobs: row.jobWeights.size });
      continue;
    }
    sections[category].push({
      term,
      category,
      status,
      kind,
      jobs: row.jobWeights.size,
      required: row.required.size,
      interested: row.interested.size,
      lowWeight: row.lowWeight.size,
      rank: Number([...row.jobWeights.values()].reduce((sum, value) => sum + value, 0).toFixed(1)),
      examples: row.companies,
      coverage: row.coverage,
      keyword: row.keyword,
      explanation: row.explanation || row.note,
      suggestion: row.suggestion,
      evidence: row.evidence,
      inResume: appearsInResume(term, row.key, resume),
    });
  }
  for (const list of Object.values(sections)) {
    // Terms you are working on lead, terms the resume already has trail.
    list.sort((left, right) => (Number(right.status === 'in_progress') - Number(left.status === 'in_progress'))
      || (Number(left.inResume) - Number(right.inResume))
      || (right.rank - left.rank)
      || ((right.jobs - right.lowWeight) - (left.jobs - left.lowWeight))
      || left.term.localeCompare(right.term));
  }

  return {
    totals: {
      jobs: observations.length,
      strongFit: observations.filter((observation) => Number(observation.score) >= STRONG_FIT_SCORE).length,
      interested: observations.filter((observation) => observation.decision === 'interested').length,
      lowWeight: observations.filter((observation) => LOW_WEIGHT_DECISIONS.has(observation.decision)).length,
    },
    sections,
    hidden: hidden.sort((left, right) => left.term.localeCompare(right.term)),
  };
}
