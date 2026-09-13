# ADR 0002: Dependency-free multi-page dashboard

- Status: Accepted
- Date: 2026-09-09

## Context

The original dashboard rendered scan controls, run diagnostics, suitable jobs, and the company
watchlist from one HTML file and one JavaScript module. The browser fetched the full dashboard
snapshot and company registry every 2.5 seconds, even when the user was working in only one area.
Adding more company discovery, job review, or scan-diagnostics features to that structure would
increase coupling and make page-level testing harder.

## Decision

JobOps uses three server-routed HTML pages with native ES modules:

- `/scan` owns readiness checks, scan controls, live output, the newest result, automatic diagnosis,
  and an optional per-source audit. Historical timelines are not part of the daily UI.
- `/decisions` owns suitable-job review, opening, archiving, and company-candidate creation.
- `/companies` owns company discovery, explicit watch approval, pausing, and ignoring.

All pages share a small navigation shell, API client, formatters, and adaptive polling helper.
The HTTP server exposes page-focused read APIs (`/api/summary`, `/api/scan`, `/api/readiness`,
`/api/jobs`, and `/api/companies`) while retaining the bounded mutation APIs and support-only
diagnostic detail routes.
Static routes use an explicit path pattern and never expose arbitrary project files.

The dashboard remains dependency-free and requires no frontend build step. SQLite and the ATS,
WhatsApp, scoring, and deduplication pipelines are unchanged.

## Options considered

### Keep one page

Lowest immediate effort, but every new feature would keep increasing the shared DOM, polling
payload, and JavaScript coupling.

### Add a client-side SPA router

This would avoid full page navigations but keep shared state and lifecycle complexity in the
browser. The local server makes native page transitions inexpensive, so the added router state
does not provide a meaningful benefit.

### Adopt React and Vite

This would provide a mature component model, but introduces dependencies, a build pipeline, and
more repository maintenance than the current three-page, single-user application needs.

### Native multi-page application

This gives each workflow a stable URL and isolated controller while preserving the project's
simple local runtime. Shared modules prevent duplication without a framework.

## Consequences

- A scan continues in the server process when the user navigates to another page.
- Each page downloads only its domain data; the navigation shell uses a small summary response.
- Polling is self-scheduled, pauses in hidden tabs, and becomes frequent only while an action runs.
- Page refresh and browser back/forward navigation work without client-side route state.
- Shared navigation and formatting changes belong in `web/shared/`; page behavior belongs in
  `web/pages/`.
- A frontend framework should be reconsidered only if cross-page client state or component
  complexity grows substantially beyond these workflows.
