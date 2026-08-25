import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createJobScorer, runCodexExec } from '../scripts/jobs/score-job.mjs';

function config() {
  return {
    rootDir: '/tmp/jobops-test',
    filters: {
      domains: ['backend', 'data'],
      acceptedLocations: ['Tel Aviv'],
      preferredSectors: ['fintech'],
    },
    decision: { minimumScore: 4, exactMatchScore: 4.5 },
    scoring: { provider: 'codex', batchSize: 8 },
  };
}

const context = {
  profile: 'Backend engineer with production Node.js experience.',
  preferences: 'Backend roles in Tel Aviv.',
  profileHash: 'profile-hash',
};

test('Codex scorer batches jobs under the signed-in user and keeps scoring deterministic', async () => {
  const calls = [];
  const scorer = createJobScorer(config(), {
    candidateContext: context,
    runCodex: async (input) => {
      calls.push(input);
      return {
        results: [{
          jobKey: 'job-1',
          company: 'Example',
          title: 'Backend Engineer',
          summary: 'פיתוח שירותי Backend.',
          domainMatches: true,
          locationMatches: true,
          cvMatch: 5,
          seniority: 4,
          roleScope: 4,
          location: 5,
          sector: 5,
          decisionReason: 'התפקיד מתאים היטב לניסיון ה-Backend.',
          uncertainties: ['Go לא מופיעה בפרופיל.'],
        }],
      };
    },
  });

  const results = await scorer.scoreBatch([{
    candidate: { jobKey: 'job-1', source: 'WhatsApp', company: '', title: '' },
    page: { finalUrl: 'https://example.com/jobs/1', status: 'active', content: 'Go is required.' },
  }]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /missing programming language or framework is NEVER an automatic blocker/i);
  assert.equal(results[0].score, 4.7);
  assert.equal(results[0].fitLabel, 'בול מתאים');
  assert.equal(results[0].suitable, true);
  assert.deepEqual(results[0].fitBreakdown, {
    cvMatch: 5,
    seniority: 4,
    roleScope: 4,
    location: 5,
    sector: 5,
    uncertainties: ['Go לא מופיעה בפרופיל.'],
  });
  assert.equal(scorer.profileHash, 'profile-hash');
});

test('Codex scorer rejects an incomplete batch response', async () => {
  const scorer = createJobScorer(config(), {
    candidateContext: context,
    runCodex: async () => ({ results: [] }),
  });

  await assert.rejects(
    scorer.scoreBatch([{
      candidate: { jobKey: 'missing', source: 'ATS' },
      page: { finalUrl: 'https://example.com/jobs/2', status: 'active', content: 'Backend role.' },
    }]),
    /missing result/i,
  );
});

test('codex exec is forced to ChatGPT login and does not inherit API keys', async () => {
  let invocation;
  const spawnProcess = (binary, args, options) => {
    invocation = { binary, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end('{"results":[]}');
      child.emit('exit', 0);
    });
    return child;
  };
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-placeholder-never-forwarded';
  try {
    const response = await runCodexExec({
      prompt: 'Score no jobs.',
      schemaPath: '/tmp/schema.json',
      cwd: '/tmp',
      binary: '/tmp/codex',
      spawnProcess,
    });
    assert.deepEqual(response, { results: [] });
    assert.ok(invocation.args.includes('--ignore-user-config'));
    assert.ok(invocation.args.includes('forced_login_method="chatgpt"'));
    assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
