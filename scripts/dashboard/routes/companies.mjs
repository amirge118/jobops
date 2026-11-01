import { CompanyRegistryError, normalizeCompanySource, resolveCompanyCandidate } from '../../jobs/company-registry.mjs';
import { createJobStore } from '../../jobs/store.mjs';
import { readJson, requireObjectBody, sendJson } from '../http.mjs';

// The company registry: candidates, sources, probes and watch status.
function primaryCompanySourceUrl(company) {
  const sources = Array.isArray(company?.sources) ? company.sources : [];
  const source = sources.find((item) => item.enabled && item.provider !== 'unsupported') ||
    sources.find((item) => item.provider !== 'unsupported') || sources[0] || null;
  return source?.careersUrl || null;
}

export function createCompaniesRoutes({ config, queries, companyResearch, probeSource, resolveWithBrowser, browserProbe }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/companies') {
      sendJson(response, 200, await queries.companies());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/companies/resolve') {
      const body = requireObjectBody(await readJson(request), ['jobKey', 'name', 'url']);
      const store = createJobStore(config.jobsDbPath);
      try {
        let candidate;
        if (body.jobKey != null) {
          if (Object.keys(body).length !== 1 || !/^[a-f0-9]{24}$/.test(String(body.jobKey))) {
            throw new CompanyRegistryError('invalid_job_key', 'A valid job key is required');
          }
          candidate = await store.resolveCompanyCandidateForJob(String(body.jobKey));
        } else {
          if (body.name == null || body.url == null) {
            throw new CompanyRegistryError('invalid_request', 'Company name and job or careers URL are required');
          }
          candidate = resolveCompanyCandidate({
            company: body.name,
            jobUrl: body.url,
            discoverySource: 'manual',
          });
        }
        const saved = await store.upsertCompanyCandidate(candidate);
        // Explicitly flagging a job's company from the Decisions page means
        // "consider tracking this" — guarantee it lands in 'candidate',
        // even if it was previously ignored or paused (not just on first
        // discovery, which upsertCompanyCandidate alone would cover).
        const company = await store.markCompanyAsCandidate(saved.company.id);
        sendJson(response, 200, {
          candidate: company,
          sources: saved.sources,
          resolvedSource: candidate.source,
        });
      } finally { store.close(); }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/companies/research') {
      const body = requireObjectBody(await readJson(request), ['name']);
      if (body.name == null) throw new CompanyRegistryError('invalid_request', 'Company name is required');
      const result = await companyResearch(body.name);
      const store = createJobStore(config.jobsDbPath);
      try {
        const saved = await store.upsertCompanyCandidate(result.candidate);
        const resolvedSource = saved.sources.find((source) =>
          source.provider === result.candidate.source?.provider &&
          source.careersUrl === result.candidate.source?.careersUrl,
        );
        if (resolvedSource && result.probe) {
          await store.recordCompanySourceProbe(
            resolvedSource.id,
            result.probe,
            result.research?.evidenceUrls || [],
          );
        }
        const company = await store.getCompany(saved.company.id);
        sendJson(response, 200, {
          candidate: company,
          sources: company.sources,
          resolvedSource: result.candidate.source,
          research: result.research,
          probe: result.probe,
        });
      } finally { store.close(); }
      return true;
    }

    const companyManualSourceMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/manual-source$/)
      : null;
    if (companyManualSourceMatch) {
      const body = requireObjectBody(
        await readJson(request),
        ['careersUrl', 'jobPathPrefix', 'jobPathSegments', 'ignoredJobPaths', 'allowEmpty'],
      );
      if (body.careersUrl == null || body.jobPathPrefix == null || body.jobPathSegments == null) {
        throw new CompanyRegistryError('invalid_request', 'careersUrl, jobPathPrefix and jobPathSegments are required');
      }
      const store = createJobStore(config.jobsDbPath);
      try {
        const companyId = Number(companyManualSourceMatch[1]);
        const company = await store.getCompany(companyId);
        if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
        // This is the manual escape hatch for exactly the case the automated
        // research pipeline cannot close on its own: a real, working career
        // page whose ATS auto-detection came back unsupported/needs_adapter.
        // official-html is the one provider that a human can always finish
        // configuring by hand once they know the job link's URL shape.
        const source = normalizeCompanySource({
          provider: 'official-html',
          careersUrl: body.careersUrl,
          config: {
            jobPathPrefix: body.jobPathPrefix,
            jobPathSegments: body.jobPathSegments,
            ignoredJobPaths: body.ignoredJobPaths,
            allowEmpty: body.allowEmpty,
          },
        });
        const probe = await probeSource(source, company.name);
        const verified = ['verified_jobs', 'verified_empty'].includes(probe.status);
        const saved = await store.upsertCompanySource(companyId, { ...source, enabled: verified });
        await store.recordCompanySourceProbe(saved.id, probe, []);
        sendJson(response, 200, { company: await store.getCompany(companyId), probe });
      } finally { store.close(); }
      return true;
    }

    const companyBrowserProbeGetMatch = request.method === 'GET'
      ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/browser-probe$/)
      : null;
    if (companyBrowserProbeGetMatch) {
      const companyId = Number(companyBrowserProbeGetMatch[1]);
      if (browserProbe.companyId !== companyId) {
        sendJson(response, 200, { status: 'idle' });
      } else if (browserProbe.running) {
        sendJson(response, 200, { status: 'running', startedAt: browserProbe.startedAt });
      } else if (browserProbe.error) {
        sendJson(response, 200, { status: 'error', error: browserProbe.error });
      } else {
        sendJson(response, 200, { status: 'done', probe: browserProbe.probe });
      }
      return true;
    }

    const companyBrowserProbePostMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/browser-probe$/)
      : null;
    if (companyBrowserProbePostMatch) {
      if (browserProbe.running) {
        throw Object.assign(new Error('כבר מתבצעת בדיקת דפדפן על חברה אחרת. יש להמתין לסיומה.'), { statusCode: 409 });
      }
      const body = requireObjectBody(await readJson(request), ['url']);
      const companyId = Number(companyBrowserProbePostMatch[1]);
      const lookupStore = createJobStore(config.jobsDbPath);
      let company;
      try { company = await lookupStore.getCompany(companyId); } finally { lookupStore.close(); }
      if (!company) throw new CompanyRegistryError('company_not_found', 'Company was not found');
      const candidateUrl = body.url || primaryCompanySourceUrl(company);
      if (!candidateUrl) {
        throw new CompanyRegistryError('invalid_request', 'A careers URL is required to try a browser probe');
      }

      // Checked again: the awaits above let another request claim the slot.
      if (browserProbe.running) {
        throw Object.assign(new Error('כבר מתבצעת בדיקת דפדפן על חברה אחרת. יש להמתין לסיומה.'), { statusCode: 409 });
      }
      Object.assign(browserProbe, {
        running: true, companyId, startedAt: Date.now(), probe: null, error: null,
      });
      // Fire-and-forget: this endpoint returns immediately (202) and the
      // dashboard polls GET .../browser-probe for the outcome, exactly
      // because a real browser render can take many seconds — see
      // scripts/jobs/browser-fetch.mjs.
      resolveWithBrowser({ companyName: company.name, candidateUrls: [candidateUrl], evidenceUrls: [] })
        .then(async (result) => {
          const persistStore = createJobStore(config.jobsDbPath);
          try {
            const saved = await persistStore.upsertCompanyCandidate(result.candidate);
            const resolvedSource = saved.sources.find((source) =>
              source.provider === result.candidate.source?.provider &&
              source.careersUrl === result.candidate.source?.careersUrl);
            if (resolvedSource && result.probe) await persistStore.recordCompanySourceProbe(resolvedSource.id, result.probe, []);
          } finally { persistStore.close(); }
          browserProbe.probe = result.probe;
        })
        .catch((error) => {
          browserProbe.error = String(error?.message || error || 'הבדיקה בדפדפן נכשלה').slice(0, 300);
        })
        .finally(() => { browserProbe.running = false; });

      sendJson(response, 202, { status: 'running' });
      return true;
    }

    const companyWatchMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/watch$/)
      : null;
    if (companyWatchMatch) {
      const body = requireObjectBody(await readJson(request), []);
      void body;
      const store = createJobStore(config.jobsDbPath);
      try {
        const companyId = Number(companyWatchMatch[1]);
        await store.approveCompany(companyId);
        sendJson(response, 200, { company: await store.getCompany(companyId) });
      } finally { store.close(); }
      return true;
    }

    const companyStatusMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/companies\/([1-9]\d{0,8})\/status$/)
      : null;
    if (companyStatusMatch) {
      const body = requireObjectBody(await readJson(request), ['status']);
      if (!['paused', 'ignored'].includes(body.status)) {
        throw new CompanyRegistryError('invalid_status', 'Status must be paused or ignored');
      }
      const store = createJobStore(config.jobsDbPath);
      try {
        const companyId = Number(companyStatusMatch[1]);
        await store.setCompanyStatus(companyId, body.status);
        sendJson(response, 200, { company: await store.getCompany(companyId) });
      } finally { store.close(); }
      return true;
    }

    return false;
  };
}
