# ADR 0012: Applications are rows, and the pipeline file stops growing

- Status: Accepted
- Date: 2026-11-01

## Context

Applications lived in `data/applications.md`, which skills, scripts and the dashboard all wrote without coordination.
`data/pipeline.md` had grown to 753 "pending" URLs, but checking them showed that none waited for a decision: 333 were
decided, 230 archived and 11 rejected. The other 179 aren't in the database under that URL, and their cause was not
established. Scans appended to it, and nothing marked an entry as handled.

## Decision

- `applications` holds one row per application per user. The file is imported once on first use, and `/tracker` lists,
  filters and edits. The format is parsed and rendered without changing it, which a test checks.
- `templates/states.yml` stays the one list of statuses (hard rule 4). Edits accept those values only. An "applied"
  decision never moves a row backwards, as before.
- `data/applications.md` stays a copy for skills, under the same rule as profile documents: a hand edit is reported and
  never overwritten, and counts only after `npm run tracker:adopt`, which replaces the rows with the file's.
- Interview stories become a fourth document kind and get the same editor and history.
- Scans stop writing `data/pipeline.md`, and the Decisions page is the one place for suitable jobs. The file is left in
  place, and `/evaluate pipeline` can still read it.

## Consequences

- Legacy tools such as `npm run dedup` and `npm run normalize` still edit the file, so running one requires adopting.
- A status that was already non-canonical in a file is kept until edited, so importing loses nothing.
- Duplicates already in a file are kept as separate rows. Hard rule 4 applies to new rows, and `npm run dedup` cleans the old.
