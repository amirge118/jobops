# ADR 0013: A store works for one user

- Status: Accepted
- Date: 2026-11-01

## Context

Decisions, company blocks, gap data, weekly reports and alerts had no owner, so a second user would have shared them all.

## Decision

- `createJobStore(path, { userId })` binds a store to one user, with `resolveCurrentUser` as the default. Repositories filter
  personal tables by it, so callers don't pass a user on every call, and can't pass the wrong one.
- `job_decisions`, `blocked_companies`, `gap_observations`, `gap_term_statuses`, `gap_term_coverage`, `weekly_reports` and
  `notification_outbox` gain `user_id` in their keys. Existing rows belong to user 1, with their `CHECK` lists and ids kept.
- Alerts are queued per person, and the same job can alert two people. WhatsApp sends only the owner's. Others get them on
  the page, then by email with hosting: sending to others from the number that feeds everyone would endanger it.

## Consequences

- `user_id` defaults to 1 in those tables, which keeps writers simple until accounts exist. Remove the default with login.
- Documents, settings and applications take an explicit `userId`, from before this decision. Both forms are safe; aligning
  them is a small later cleanup.
- `jobs` still holds verdicts and archive state, so one user's decision still archives a job for everyone until it is split.
- `personal_improvements` has no reader or writer in the code, and is left as it is.
