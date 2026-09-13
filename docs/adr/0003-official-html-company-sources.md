# ADR-0003: Scan simple official HTML career pages

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** Project owner and maintainer

## Context

The company registry originally enabled only known public ATS providers. This
kept collection deterministic, but it also paused official career pages that
already expose stable, server-rendered links to individual jobs. A live audit
of the paused catalogue found a useful middle tier: pages that need neither a
private API nor browser automation and can be scanned with one bounded HTTP
request.

## Decision

Add an `official-html` provider for explicitly configured companies. Each
source must provide an exact same-origin path prefix and an exact path segment
count. The provider downloads a bounded HTML document, extracts matching links,
and derives a title from the link or its nearest heading. It never follows
redirects and never executes page scripts.

Only sources verified during the audit are enabled. Pages that are blocked,
client-rendered, empty, redirected, or structurally ambiguous remain paused.

## Options Considered

### Known ATS APIs only

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Reliability | High |
| Coverage | Too low |

### Generic browser scraper

| Dimension | Assessment |
| --- | --- |
| Complexity | High |
| Runtime cost | High |
| Coverage | Broad but fragile |

### Explicit official HTML rules

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Runtime cost | One HTTP request per company |
| Coverage | Good for the audited middle tier |

## Consequences

- More official company pages can be checked in the normal ATS run.
- A layout change fails visibly instead of silently enabling arbitrary links.
- Some companies still need a future ATS discovery, JSON endpoint, or browser
  adapter.
- The path rule is configuration, so adding a new simple source is reviewable
  and does not require a new provider module.

## Safety Invariants

- Listing URLs must be public HTTPS URLs.
- Redirects are rejected.
- Only same-origin job links are returned.
- HTML size, link count, path prefix length, and path depth are bounded.
- No HTML or response body is persisted in logs or SQLite.
