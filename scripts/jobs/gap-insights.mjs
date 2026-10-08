// Aggregates the stored per-job resume-gap analyses (gap_observations) into
// "what is missing for a perfect fit": a short learning focus, wording fixes
// the profile already proves, and every gap grouped by subject.
// Pure: no store or file access, so it is tested directly.

import { SCORE_MISS_DECISIONS, WANTED_JOB_DECISIONS } from './decisions.mjs';

export const GAP_CATEGORIES = ['tool', 'experience', 'keyword'];
const STRONG_FIT_SCORE = 4;
// Jobs whose role itself was wrong for you (not relevant, too senior) still
// count as demand, but only faintly, so their gaps cannot push the top of the
// lists. Passing on a fitting role for other reasons keeps full weight.
const LOW_WEIGHT_FACTOR = 0.25;
const MAX_EXAMPLES = 3;
const FOCUS_MIN_JOBS = 2;
const MAX_FOCUS_TOPICS = 3;
const MAX_FOCUS_TERMS = 3;
const MAX_QUICK_FIXES = 6;

// The personal area groups gaps by subject so a pattern across jobs ("AI comes
// up in half of them") shows even when each single term appears only once.
// First match wins, so narrow topics come before the broad ones they overlap
// ("Vector Databases" is AI, "Go-to-Market" is not the Go language). Only
// learnable topics can become a learning focus; minor ones (years, niche
// domains) are listed last and collapsed.
export const GAP_TOPICS = [
  { id: 'years', label: 'שנות ניסיון', learnable: false, minor: true,
    pattern: /\byears?\b|^\s*\d/ },
  { id: 'domain', label: 'תחומים ספציפיים', learnable: false, minor: true,
    pattern: /\biam\b|identity|cyber|security|defen[cs]e|\bivr\b|\bcti\b|genesys|ccaas|contact cent|embedded|hardware|fintech|healthcare|telecom/ },
  { id: 'ai', label: 'AI ו-LLM', learnable: true, minor: false,
    pattern: /\bai\b|llm|genai|\bml\b|machine learning|model|prompt|\brag\b|agent|nlp|embedding|vector|pytorch|tensorflow|hugging ?face|vertex|\bmcp\b|copilot|codex|openai|langchain|fine.?tun|context engineering|tool calling|custom tools|ground truth|error analysis|classification|entity resolution/ },
  { id: 'data', label: 'נתונים ובסיסי נתונים', learnable: true, minor: false,
    pattern: /sql|oracle|postgres|mongo|redis|elastic|database|\bdata\b|\betl\b|\belt\b|spark|databricks|warehous|star schema|kafka|rabbitmq|snowflake|bigquery|\bdbt\b|airflow/ },
  { id: 'scale', label: 'סקייל, ביצועים ותשתיות', learnable: true, minor: false,
    pattern: /scal(?:e|ab|ing)|throughput|latency|concurren|multithread|real-time|infrastructure|platform|terraform|ansible|kubernetes|\bk8s\b|docker|network|\bhttp|memory|distributed|cloud|\baws\b|\bgcp\b|azure|debugging|observability|performance|microservice|devops|ci\/?cd/ },
  // Mostly a matter of how the resume words things, not something to study.
  { id: 'practices', label: 'שיטות עבודה ואימפקט', learnable: false, minor: false,
    pattern: /agile|scrum|ownership|business|impact|collaborat|\blead|mentor|consult|go-to-market|monetiz|pricing|revenue|testing|architecture|product|stakeholder|communication/ },
  { id: 'languages', label: 'שפות ופריימוורקים', learnable: true, minor: false,
    pattern: /^(go|golang|java|python|c\+\+|c#.*|\.net.*|typescript|javascript|node.*|react|angular|vue|spring.*|rust|scala|kotlin|ruby|php)$|front.?end|full.?stack|back.?end/ },
  { id: 'other', label: 'אחר', learnable: false, minor: true, pattern: /(?:)/ },
];

export function topicOf(term) {
  const text = String(term || '').toLowerCase().trim();
  return GAP_TOPICS.find((topic) => topic.pattern.test(text)).id;
}

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

// coveredTerms: term keys a Codex check found the current resume already
// covers in other words (gap-coverage.mjs); the plain text match handles the rest.
export function aggregateGaps(observations, { currentResumeText = '', statuses = [], coveredTerms = new Set() } = {}) {
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
    const lowWeight = SCORE_MISS_DECISIONS.has(observation.decision);
    const effective = lowWeight ? weight * LOW_WEIGHT_FACTOR : weight;
    row.jobWeights.set(observation.jobKey, Math.max(row.jobWeights.get(observation.jobKey) || 0, effective));
    if (WANTED_JOB_DECISIONS.has(observation.decision)) row.interested.add(observation.jobKey);
    if (lowWeight) row.lowWeight.add(observation.jobKey);
    if (observation.company && !row.companies.includes(observation.company) && row.companies.length < MAX_EXAMPLES) {
      row.companies.push(observation.company);
    }
  };

  // Newest first, so the first explanation a row sees is the most recent one.
  const sorted = [...observations].sort((left, right) => Number(right.observedAt || 0) - Number(left.observedAt || 0));
  for (const observation of sorted) {
    const base = (Number(observation.score) >= STRONG_FIT_SCORE ? 1.5 : 1)
      + (WANTED_JOB_DECISIONS.has(observation.decision) ? 1 : 0);
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

  const topicRows = new Map(GAP_TOPICS.map((topic) => [topic.id, []]));
  const topicJobs = new Map(GAP_TOPICS.map((topic) => [topic.id, new Map()]));
  const hidden = [];
  let coveredByResume = 0;
  for (const row of rows.values()) {
    const term = mostCommon(row.spellings, row.key);
    // Older analyses ran against an older resume; once the current one says
    // the term, it is no longer a gap.
    if (coveredTerms.has(row.key) || appearsInResume(term, row.key, resume)) {
      coveredByResume += 1;
      continue;
    }
    // Rows seen only as employer priorities are screening phrases by nature.
    const category = mostCommon(row.categories, 'keyword');
    const topic = topicOf(term);
    // One job with profile evidence is enough to make it a wording fix.
    const kind = row.kinds.has('safe_addition') ? 'safe_addition' : mostCommon(row.kinds, null);
    const status = statusOf.get(row.key) || null;
    if (status === 'hidden') {
      hidden.push({ term, topic, jobs: row.jobWeights.size });
      continue;
    }
    // A topic counts each job once, at the strongest weight any of its terms gave it.
    const jobs = topicJobs.get(topic);
    for (const [jobKey, weight] of row.jobWeights) jobs.set(jobKey, Math.max(jobs.get(jobKey) || 0, weight));
    topicRows.get(topic).push({
      key: row.key,
      term,
      category,
      topic,
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
    });
  }
  // Terms you are working on lead.
  const byPriority = (left, right) => (Number(right.status === 'in_progress') - Number(left.status === 'in_progress'))
    || (right.rank - left.rank)
    || ((right.jobs - right.lowWeight) - (left.jobs - left.lowWeight))
    || left.term.localeCompare(right.term);

  const topics = GAP_TOPICS
    .map((topic) => {
      const weights = [...topicJobs.get(topic.id).values()];
      return {
        id: topic.id,
        label: topic.label,
        learnable: topic.learnable,
        minor: topic.minor,
        jobs: weights.length,
        rank: Number(weights.reduce((sum, value) => sum + value, 0).toFixed(1)),
        rows: topicRows.get(topic.id).sort(byPriority),
      };
    })
    .filter((topic) => topic.rows.length > 0)
    // Topics are ranked by how many jobs ask for them, not by how many terms they hold.
    .sort((left, right) => (Number(left.minor) - Number(right.minor))
      || (right.jobs - left.jobs) || (right.rank - left.rank));

  // What to learn: the learnable topics that recur across jobs, each with the
  // terms to start from. A topic seen in one job is not a pattern yet.
  const focus = topics
    .filter((topic) => topic.learnable && topic.jobs >= FOCUS_MIN_JOBS)
    .slice(0, MAX_FOCUS_TOPICS)
    .map((topic) => ({
      id: topic.id,
      label: topic.label,
      jobs: topic.jobs,
      // Recurring terms first: they are where one effort pays off in several jobs.
      terms: topic.rows.filter((row) => row.kind !== 'safe_addition')
        .sort((left, right) => (right.jobs - right.lowWeight) - (left.jobs - left.lowWeight) || byPriority(left, right))
        .slice(0, MAX_FOCUS_TERMS).map((row) => ({ term: row.term, jobs: row.jobs })),
    }))
    .filter((topic) => topic.terms.length > 0);

  // Wording fixes: the profile already proves these, the resume just does not say them.
  const quickFixes = topics.flatMap((topic) => topic.rows)
    .filter((row) => row.kind === 'safe_addition')
    .sort(byPriority)
    .slice(0, MAX_QUICK_FIXES);

  return {
    totals: {
      jobs: observations.length,
      strongFit: observations.filter((observation) => Number(observation.score) >= STRONG_FIT_SCORE).length,
      interested: observations.filter((observation) => WANTED_JOB_DECISIONS.has(observation.decision)).length,
      lowWeight: observations.filter((observation) => SCORE_MISS_DECISIONS.has(observation.decision)).length,
    },
    coveredByResume,
    focus,
    quickFixes,
    topics,
    hidden: hidden.sort((left, right) => left.term.localeCompare(right.term)),
  };
}
