import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompanyResearcher } from '../scripts/jobs/company-research.mjs';

const config = { rootDir: '/tmp/jobops-company-research', scoring: {} };

test('company research uses live Codex search and validates the result as a candidate', async () => {
  let invocation;
  const research = createCompanyResearcher(config, {
    runCodex: async (input) => {
      invocation = input;
      return {
        companyName: 'Acme', candidateUrls: ['https://jobs.lever.co/acme/role-id'],
        rationale: 'Official careers link points to this board.',
        evidenceUrls: ['https://www.acme.example/careers', 'https://jobs.lever.co/acme'],
      };
    },
    resolveSources: async ({ companyName, candidateUrls, evidenceUrls }) => ({
      candidate: {
        name: companyName, canonicalDomain: null, discoverySource: 'research', resolutionStatus: 'resolved', status: 'candidate',
        source: { provider: 'lever', boardKey: 'acme', careersUrl: 'https://jobs.lever.co/acme', apiUrl: null, enabled: true },
      },
      probe: { status: 'verified_jobs', count: 2, samples: [] },
      evidenceUrls,
      attemptedSources: candidateUrls.length,
    }),
  });

  const result = await research(' Acme ');
  assert.equal(invocation.liveSearch, true);
  assert.equal(invocation.timeoutMs, 90_000);
  assert.match(invocation.prompt, /Do not run shell commands/i);
  assert.match(invocation.prompt, /concise Hebrew sentence/i);
  assert.match(invocation.prompt, /up to five candidate URLs/i);
  assert.equal(result.candidate.status, 'candidate');
  assert.equal(result.candidate.source.provider, 'lever');
  assert.equal(result.probe.status, 'verified_jobs');
  assert.equal(result.research.sourceKind, 'dedicated_ats');
  assert.equal(result.research.evidenceUrls.length, 2);
});

test('company research rejects unsafe output from the model', async () => {
  const research = createCompanyResearcher(config, {
    runCodex: async () => ({
      companyName: 'Acme', candidateUrls: ['https://127.0.0.1/private'],
      rationale: 'No.', evidenceUrls: ['https://127.0.0.1/private'],
    }),
  });
  await assert.rejects(research('Acme'), /private IP|DNS hostname/);
});

test('company research limits concurrent runs', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const research = createCompanyResearcher(config, {
    runCodex: async () => {
      await wait;
      return {
        companyName: 'Acme', candidateUrls: ['https://jobs.lever.co/acme'],
        rationale: 'Verified.', evidenceUrls: ['https://jobs.lever.co/acme'],
      };
    },
    resolveSources: async ({ companyName, evidenceUrls }) => ({
      candidate: {
        name: companyName, canonicalDomain: null, discoverySource: 'research', resolutionStatus: 'resolved', status: 'candidate',
        source: { provider: 'lever', boardKey: 'acme', careersUrl: 'https://jobs.lever.co/acme', apiUrl: null, enabled: true },
      },
      probe: { status: 'verified_empty', count: 0, samples: [] }, evidenceUrls, attemptedSources: 1,
    }),
  });
  const first = research('Acme');
  await assert.rejects(research('Other'), (error) => error.code === 'company_research_busy');
  release();
  await first;
});
