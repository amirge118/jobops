# ADR 0008: Request guard, route modules and a per-user foundation

- Status: Accepted
- Date: 2026-11-01

## Context

The dashboard is about to edit personal data such as a CV and search preferences. It binds to
loopback only, but a website open in the same browser can still reach it. Only two routes required
a JSON content type, nothing checked `Origin` or `Host`, and one 450-line `if` chain in `scripts/web.mjs`
held every route.

## Decision

- `scripts/dashboard/request-guard.mjs` runs before routing on every request:
  - A `Host` outside loopback gets 403 on reads too, which blocks DNS rebinding.
  - A write with a foreign `Origin` or a cross-site `Sec-Fetch-Site` gets 403.
  - A write with a body must be `application/json`, otherwise 415.
  - Requests with neither header, such as curl, stay allowed. They already run as this user.
- Routes live in `scripts/dashboard/routes/` by domain, and a route handled a request when it returns `true`.
- `readJson` takes a per-route `maxBytes`, with 32 KB as the default.
- `users` holds one local user, and `resolveCurrentUser` is the only place that decides who is acting.
- `user_settings` stores per-user values, limited to the allowlist in `scripts/jobs/user-settings.mjs`.
  A stored value overrides `config/jobs.yml`, which overrides the code default.

## Consequences

- This protects against other websites, not against other local programs or people. Login and sessions
  arrive with hosting, and the guard's trust in header-less requests must be reviewed then.
- A hosted deployment must add its real hostname to the guard's allowlist.
- The settings allowlist starts with two notification keys. No scan or route reads it yet, because each
  setting gets wired when its page exists, and until then `config/jobs.yml` stays authoritative.
- Personal tables have no `user_id` yet; a later migration adds it.
