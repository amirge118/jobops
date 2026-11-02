# ADR 0011: Sources are shared and run on the owner's accounts

- Status: Accepted
- Date: 2026-11-01

## Context

WhatsApp groups, LinkedIn searches and source switches lived in `config/jobs.yml`. Moving them into the app raises the
question of whose accounts they use. WhatsApp runs through an unofficial client, with a risk of the number being
banned, stored session keys, and other people's messages. LinkedIn is read without login, with a shared request budget.

## Decision

- Only the owner connects WhatsApp, and it feeds a shared pool of jobs. Others get those jobs without connecting a
  phone. Only the extracted posting is kept; `message_text` is already cleared once a message is processed.
- Changing shared sources needs `requireOwner`, while everyone manages their own alerts and blocked companies.
- The collector records the account's groups on every connect, so the picker needs no separate WhatsApp connection,
  which would conflict with the collector. The API uses opaque ids and never returns a group's address.
- Up to six LinkedIn searches can be saved. Rate limits stay out of settings, so more searches share the same budget
  and each updates more slowly, as the page says.
- `loadEffectiveConfig` gives each process the file plus saved settings, once at start. Saving groups restarts the
  collector, and the dashboard too unless an action is running.
- The company catalog is shared, so each company is scanned once for everyone. Blocking stays personal.

## Consequences

- One WhatsApp number is a single point of failure, and the groups reflect the owner's network.
- The legal position of reading WhatsApp and LinkedIn for other people must be reviewed before hosting.
- Until personal tables gain `user_id`, blocked companies belong to the one local user.
