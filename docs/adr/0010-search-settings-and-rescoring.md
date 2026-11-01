# ADR 0010: Search rules are settings, and re-scoring needs approval

- Status: Accepted
- Date: 2026-11-01

## Context

The scoring prompt held one person's assumptions: Backend, Israel, a level cap, no people management, and no data
roles. Title filters in `portals.yml` dropped about 90% of jobs before scoring and were also tuned to that person, so
someone in another field would have silently seen nothing. Any profile change also re-scored jobs whenever they were
seen again, spending AI quota nobody had approved.

## Decision

- The prompt is built in `candidate/scoring-prompt.mjs` from settings. What depends on a profession lives in
  `scoring-presets.mjs`: `backend` keeps the calibrated wording, and `generic` works from `search.focusRole`.
- A golden test holds the prompt the existing scores came from, so a settings change can't alter it unnoticed. The
  one deliberate edit: "an Israeli posting" became "a posting in Israel", so that any country works.
- Phone, email, LinkedIn and GitHub lines no longer reach the AI provider.
- `applyUserSettings` overlays stored settings on the config, so existing consumers need no change. The allowlist
  excludes operational values such as rate limits and `criteriaVersion`. A form saves all or nothing.
- The settings the prompt uses join the scoring hash. Thresholds and pre-filters do not, since they neither change a
  verdict's reasoning nor cost AI quota to change.
- Title and location pre-filters resolve per list from the user's settings, then `portals.yml`. AI can suggest lists
  from what the person is looking for, and they are saved only after review.
- A verdict stays until `rescore_requested_at` is set. New jobs use the new settings at once, so a list can mix
  verdicts until the person confirms. `/profile` shows the count and estimated tokens first. A new `criteriaVersion`
  and new page content still re-score automatically, as both are about the job or the system.
- Rejected jobs kept no text, so including them means reading the source again. It is optional, limited to the last 14
  days and 200 jobs.

## Consequences

- The scan and the dashboard share one set of title filters, so per-user filtering of a shared scan is still open.
- Thresholds apply to future evaluations only. An earlier rejection doesn't return by lowering the minimum score.
- Gap analysis waits for a job's verdict to match the current profile, so it pauses for old jobs until a re-score.
- A twin of an already decided job, found after a profile change, is still scored once as a new posting.
- Hebrew output and some engineering examples in the seniority anchor remain, and are reviewed with onboarding.
