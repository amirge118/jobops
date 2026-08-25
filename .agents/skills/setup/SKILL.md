---
name: setup
description: Import CV and build the candidate profile. Run first, and re-run any time the CV or preferences change.
---

# /setup — Build or update the candidate profile

Goal: turn whatever is in `documents/` plus a short interview into a complete,
verified profile in `profile/`. Idempotent — re-running updates rather than duplicates.

## Steps

1. **Scan `documents/`.** Read every CV (PDF/Word), LinkedIn export, diploma, or past
   application found there. If the folder is empty, ask the user to drop their CV in
   `documents/` (or paste it) and stop until they do.

2. **Build `profile/01-candidate-profile.md`.** Extract identity, experience (with
   dates, companies, locations, achievements), education, skills, projects,
   certifications. Keep every quantifiable achievement (numbers, scale, impact) —
   these are the raw material for tailored CVs. Never invent or embellish; if a date
   or detail is unclear, ask.

3. **Interview for `profile/02-preferences.md`.** Use AskUserQuestion / conversation to fill:
   target roles, sectors, salary target, location/remote policy, deal-breakers,
   what excites them, strengths, best achievement. Skip questions already answered.

4. **Update `portals.yml`:** rewrite `title_filter.positive`/`negative` to match the
   target roles from step 3 (keep the Israeli `location_filter` unless told otherwise).
   Add any companies the user names to `tracked_companies`.

5. **Verify:** read back both profile files; confirm with the user that everything is
   accurate. Fix anything they flag.

6. **Update README.md** "Status" section: profile ready ✅.

## Rules
- The profile is the single source of truth — generated CVs may only contain claims backed by it.
- Profile files are user data: never overwrite silently on re-runs; merge and show diffs of substance.
