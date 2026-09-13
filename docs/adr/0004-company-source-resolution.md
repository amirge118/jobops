# ADR 0004: Resolve and probe company job sources before approval

- Status: Accepted
- Date: 2026-09-13

## Context

Company research previously returned one URL and classified it only by its visible URL shape. Many
official careers pages embed a Greenhouse, Ashby, or Comeet board, so valid sources were stored as
unsupported and auto-paused. A generic browser scraper would cover more pages initially but would
make the daily scan slow, stateful, and difficult to diagnose.

## Decision

Use a two-part onboarding pipeline:

1. Signed-in Codex web research returns up to five evidence-backed candidate URLs.
2. Deterministic local code normalizes the candidates, inspects bounded public HTML when necessary,
   detects supported embedded ATS sources, and probes the selected provider for real jobs.

Research never approves a company. A source becomes approvable only after its provider returns a
valid job list; an empty list is a successful `verified_empty` result. Failures receive stable,
bounded status and reason fields instead of being mixed into the company's user-controlled state.

Discovery HTML is untrusted. Each request uses public HTTPS validation, public DNS checks, manual
redirect validation, a redirect cap, timeout, content-type restriction, and a streamed size limit.
Provider-specific API calls continue to use their existing host allowlists.

## Alternatives considered

### One browser scraper for every company

Rejected as the default because it is slower, depends on a long-lived browser profile, triggers
more anti-bot controls, and turns ordinary API boards into brittle UI automation. A browser remains
a later fallback for sources that prove they require JavaScript or return an anti-bot response.

### One custom script per company

Rejected because it scales maintenance with the number of companies. Reusable provider adapters
and small bounded declarative rules cover shared platforms and common page shapes instead.

### Trust the URL selected by web research

Rejected because search results can be stale and pages are untrusted. Research supplies candidates
and evidence; only deterministic probing determines whether a source is ready for daily scanning.

## Consequences

- Adding a company by name takes longer than a regex-only lookup because it performs verification.
- Existing supported ATS providers can immediately recover many previously paused companies.
- Zero openings are represented distinctly from collection failure.
- Unsupported custom JSON, Workday, Zoho Recruit, TeamMe, and browser-only sources still require
  bounded reusable adapters; the resolver reports that requirement rather than silently enabling
  them.
- Future source adapters should plug into the same probe result contract and keep approval separate.
