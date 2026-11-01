# ADR 0007: A driver-independent storage layer

- Status: Accepted
- Date: 2026-11-01

## Context

All persistence lived in one 3,749-line `scripts/jobs/store.mjs`: schema, data cleanups, and about 150
methods across unrelated domains, all inside a single closure. Reports (`pulse`, `weekly-stats`,
`scan-health`, `linkedin-canary`) bypassed it with 50 of their own SQL statements against the file. The
schema changed through `ALTER` checks and row cleanups repeated on every open, with no record of what had
run. The API was synchronous, so no networked database could stand behind it. The product may move to
Postgres and to more than one user.

## Decision

- `scripts/jobs/store.mjs` stays the only public entry point, with the same flat `store.method()` API.
- `scripts/jobs/store/repositories/` holds one module per domain. All SQL lives under `scripts/jobs/store/`.
- `scripts/jobs/store/database.mjs` is the only module that loads the driver. Repositories use an async
  surface a Postgres driver can also provide: `prepare(sql).get/all/run`, `exec`, `transaction`, `close`.
- `scripts/jobs/store/migrations/` holds append-only numbered migrations, recorded in `schema_migrations`
  and run once per database. `001-baseline` is the old on-open code, idempotent for databases of any age.
- `createJobStore(path, { readonly: true })` opens without writing anything, for read-only tools.
- `tests/jobs-store-architecture.test.mjs` enforces these boundaries.

## Consequences

- Moving to async removed the implicit atomicity of synchronous code. Multi-step writes now use
  transactions, and in-process guards claim their state before the first `await`.
- One SQLite connection holds one transaction. Other callers on that connection wait for it, tracked with
  `AsyncLocalStorage`, and a Postgres implementation must keep this behavior per pooled client.
- A statement still executes at the call when nothing blocks it, and that is what lets crash and exit
  handlers record a run's end. A Postgres adapter can't do this, so such runs would rely on heartbeat-based
  stale-run detection.
- SQLite-specific SQL remains and must be ported with the driver: `INSERT OR`, `json_each`, `strftime`,
  `lastInsertRowid`, `PRAGMA` and `sqlite_master`. They are now all under `scripts/jobs/store/`.
- A new decision key needs a migration that widens the `job_decisions` CHECK list. The old code did this
  automatically on open.
- This ADR does not change the data model. No table has a user yet, and `jobs` still mixes the posting
  with its evaluation.
