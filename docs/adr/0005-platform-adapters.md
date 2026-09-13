# ADR 0005: Scan companies through reusable platform adapters

- Status: Accepted
- Date: 2026-09-13

## Context

The watchlist includes companies whose career pages are hosted by shared hiring platforms. Writing
one parser per company would duplicate URL rules, pagination, validation, failure handling, and
tests. It would also make company research unable to activate a newly discovered source without a
code change.

## Decision

Treat a source as a platform URL plus small validated configuration. A provider adapter owns the
platform protocol and emits the existing normalized job contract: `title`, `url`, `company`,
`location`, and optional `postedAt`.

The registry detects platform URL shapes and stores provider configuration as bounded JSON. The
daily scanner converts that configuration back to explicit provider fields. Company research uses
the same detector and the same provider implementation for its live probe, so a source cannot be
marked verified by a different path than the one used later.

The first added adapters are:

- `workday`: derives the public CXS endpoint from tenant and career-site URL, paginates it, and can
  apply a brand `search_text` for acquired companies on a parent board.
- `zoho-recruit`: reads Zoho's embedded bounded jobs payload and builds same-origin detail URLs.
- `teamme`: reads schema.org `JobPosting` records from the TeamMe page and accepts an external job
  URL only when the same record declares the matching official organization host.

All adapters require HTTPS, constrain platform hosts, bound response sizes or result counts, use
timeouts, and never execute page scripts.

## Consequences

Adding another company on a supported platform is data entry, not parser development. Adding a new
platform still requires one reviewed adapter and tests. Custom sites remain supported through the
declarative `official-html` adapter when their server-rendered link shape is stable; complex
anti-bot or browser-only sites stay unsupported until they justify a separate platform strategy.
