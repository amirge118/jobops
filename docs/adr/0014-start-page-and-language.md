# ADR 0014: A start page, chosen AI language, and neutral service names

- Status: Accepted
- Date: 2026-11-02

## Context

Starting took a terminal, placeholder files and Claude. Every AI answer was in Hebrew, one report prompt assumed Israel
and a backend engineer, and background services carried one person's name.

## Decision

- `/start` lists steps whose state is read from what the person already did, so there is no wizard state to keep. Any step
  can be skipped. The opening page leads there only while there is no CV.
- `npm run setup` copies only the config. A placeholder CV in `profile/` would be imported as if it were real.
- A search can run from the form alone; free text about preferences is optional.
- `ai.outputLanguage` selects from a closed list, because the value reaches prompts. The interface stays in Hebrew, so
  the first audience is Hebrew speakers in Israel; translating it is a separate decision before hosting.
- `service.labelPrefix` names background services, with `com.jobops` as the default. An existing install must keep its
  prefix, or new agents would run next to the old ones.
- `/api/profile/export` downloads a person's data, without shared-source addresses. Deleting waits for hosting, since on
  one's own computer it could wipe a whole history at one wrong click.

## Consequences

- `portals.yml` still ships one profession's keywords. The filters step stays open until the person has their own list
  or has run a scan, which is why that step doesn't trust a non-empty list.
- Remaining items are listed in `docs/multi-user-readiness.md`.
