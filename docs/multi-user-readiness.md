# Multi-user readiness

What stands between jobOps and a second real user, as of 2026-11-02. Decisions are in `docs/adr/`.

## Ready

| Area | State | ADR |
|---|---|---|
| Storage layer | Async, by domain, numbered migrations, one driver module | 0007 |
| Request safety | Foreign `Host` and `Origin` refused, JSON required on writes | 0008 |
| CV, profile, preferences, stories | Versioned documents per user, edited in the app | 0009, 0012 |
| CV file and its explanation | Uploaded file and cached AI text per user; files unencrypted until hosting decides | 0015 |
| Search rules and pre-filters | Per-user settings with a closed allowlist | 0010 |
| Re-scoring | Only after seeing the cost and confirming | 0010 |
| Sources | Shared, owner-only changes, no addresses in the page | 0011 |
| Applications | Rows per user with a page | 0012 |
| Decisions, blocks, gaps, reports, alerts | Filtered by the store's user, with negative tests | 0013 |
| Getting started and data export | `/start`, without a terminal after install | 0014 |

## Must be done before a second user

1. **Split `jobs`.** Verdicts and archive state are on the shared posting, so one person's decision archives a job for
   everyone. Decided: postings kept 30 days, verdicts per user, per-user pre-filters and a daily scoring quota.
2. **Scans for many users.** A scan loads one user's settings and filters. It has to run shared collection once, then filter
   and score per user. This depends on item 1.
3. **Who pays for AI.** Everything runs on the owner's ChatGPT login (hard rule 9), which can't serve others. The seam is
   `scripts/jobs/llm/`, with only the CV import behind it so far. Other callers must move to it.
4. **Login and sessions.** `resolveCurrentUser` always returns the local owner. Add rate limits and anti-enumeration on
   login and recovery, and negative tests across users through the API.
5. **Deleting a person's data.** Export exists and deletion doesn't.
6. **Move to Postgres.** Deliberately last. SQLite-specific SQL is all under `scripts/jobs/store/`.
7. **Encryption at rest and a backup policy.** CVs and contact details are stored unencrypted, as the files were.
8. **Legal review.** Reading WhatsApp groups and LinkedIn for other people, and the privacy law duties of holding CVs.

## Should be cleaned up

- `portals.yml` ships Backend keywords as its starter, and new users need a neutral one.
- Alerts for users other than the owner are queued but not delivered. Email comes with hosting.
- Times use `Asia/Jerusalem`, and the health check has Shabbat quiet hours. Both fit the first audience and need settings later.
- Some seniority anchors in the scoring prompt use engineering titles.
- `personal_improvements` has no reader or writer in the code.
- `user_id` defaults to 1 in personal tables, to remove with login.
- Legacy tools (`npm run dedup`, `npm run normalize`, `npm run scan`) edit files directly and need an adopt afterward.

## Known open issue

`tests/jobs-source-settings.test.mjs` failed once in a full run on 2026-11-01. The cause wasn't found, and more than 15
later runs passed.
