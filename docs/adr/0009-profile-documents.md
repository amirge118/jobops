# ADR 0009: The candidate's text lives in versioned documents

- Status: Accepted
- Date: 2026-11-01

## Context

The CV, profile and preferences were Markdown files, edited by hand or by a skill. Nobody else could use
that, and every existing score is stamped with a hash of those raw files. A change of storage must not make
970 active jobs look out of date, and each re-score costs AI quota.

## Decision

- `profile_documents` keeps one row per saved version of `profile`, `resume` and `preferences`, for each user. A
  document is plain Markdown; sections and identity fields are views over it, and split plus join return the
  exact text. This fits any profession and format, and a richer structure can come later.
- `profile` stays the source of truth for facts (hard rule 1), and `resume` is the CV used for gap analysis.
  A new user starts from one CV, which also becomes their profile until they add more.
- `canonicalScoringHash` leaves out comments and the Identity section, so a new phone number re-scores nothing.
- `scoring_hash_aliases` links that hash to the one stored scores carry. Files are imported lazily on first use,
  so moving needs no manual step, and undoing an edit restores the same hash.
- Documents win over files. A save is copied to `profile/*.md` for skills. A hand-edited file is never
  overwritten: it is reported on the page and in scans, and counts only after `npm run profile:adopt`.
- Editors send the version they started from, and a stale save gets 409 rather than losing text.
- The demo shares the real project folder, so it never reads or writes those files and seeds synthetic documents.
- `scripts/jobs/llm/` is the seam for which AI runs a request. Codex is the only provider (hard rule 9), and only
  the CV import goes through the seam so far. Who pays for other users' AI is still open.

## Consequences

- Prompts still receive the Identity section. Removing contact details from what is sent to the AI is planned
  with the prompt cleanup in the search preferences stage.
- Documents hold personal data unencrypted in the local database, like the files before them. Encryption at rest
  and a way to delete a user's data are needed before hosting.
- Older AI callers still reach Codex directly and move to the seam when a second provider appears.
