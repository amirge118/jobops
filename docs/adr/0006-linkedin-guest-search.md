# ADR 0006: Add LinkedIn as a bounded, optional discovery source

- Status: Accepted
- Date: 2026-09-28

## Context

Many Israeli roles are posted on LinkedIn before, or instead of, a company board that jobOps
already watches. LinkedIn has no public jobs API. Its logged-out `jobs-guest` endpoints are
unofficial, can be throttled per IP, and behave in ways a naive integration misreads. A live
probe on 2026-09-28 found that:

- `f_TPR` is honored (a 1-hour window returned fewer cards than a 24-hour one).
- `sortBy=DD` is accepted but not honored.
- Pages hold 10 cards, pagination by card count returns new ids, and a page past the end is an
  empty 200 body.
- An unmatched query returns unrelated "popular" jobs, not an empty page, and real results are
  followed by such filler.
- Logged-out posting pages include the full description but hide the company-site apply link.

The existing pipeline also assumed that any non-WhatsApp source is ATS, merged jobs on
company+title, and let one source's exception abort the whole run.

## Decision

- **Guest search only.** jobOps never logs in, stores no LinkedIn session, and stops on 429, 999,
  an authwall, or a sign-in page. It never retries around a block. There are no proxies, no
  CAPTCHA handling, and no paid services.
- **Per-search coverage.** Coverage lives in SQLite, keyed by search and query hash, and advances
  only after a complete, persisted collection of a contiguous window. Automatic and manual windows
  share one planner. Catch-up is capped and leftover gaps are shown.
- **Failures are never "no jobs".** Responses are classified as `ok`, `empty`, `blocked`,
  `rate_limited`, `structure_changed`, `network_error`, or `timeout`. An empty first page is
  trusted only when another search in the same run proved the endpoint was answering. Filler
  pages are detected by title relevance and are neither stored nor scored.
- **Existing pipeline, new identity rule.** Postings enter as ordinary sightings (`LinkedIn:
  <search>`), then go through the same verification, Codex scoring, and resume-gap analysis.
  Identity is the numeric posting id. LinkedIn sightings never merge on company+title and are only
  flagged `possible_duplicate_of`. ATS and WhatsApp keep their existing rule.
- **Isolation.** LinkedIn collection is wrapped so that its failure is recorded without aborting
  ATS or WhatsApp. The shared ATS/WhatsApp window is anchored by a `window_status` computed without
  LinkedIn. A disabled source makes no requests, including through the retry queue.
- **Configuration.** `config/jobs.yml` is the single source of truth for searches; the dashboard
  displays them and can only switch the whole source off. Search definitions are rare, deliberate
  changes, so a browser editor added surface without value.

## Consequences

- A company+title twin across sources may be scored twice. This costs a little Codex usage to
  avoid silently merging two distinct postings.
- Most LinkedIn postings keep their LinkedIn URL, because the company-site link is usually hidden
  from logged-out visitors. When one is exposed and matches a known job, the posting is flagged
  rather than merged.
- A very broad query can hit the page cap repeatedly and never advance coverage. The UI says so,
  and the remedy is a narrower query or a shorter manual window.
- The integration depends on unofficial markup. `npm run jobs:linkedin-probe` re-checks the
  assumptions above in about 20 paced requests without touching the database.
