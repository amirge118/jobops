---
name: evaluate
description: Score a job posting against the profile (A-G blocks), save a report, record in the tracker. Accepts a URL, pasted JD, or "pipeline" to process the inbox.
---

# /evaluate — A–G job evaluation

Input: job URL, pasted JD text, or `pipeline` (process `data/pipeline.md` Pending top-down).

## Step 0 — Fetch & verify liveness
- Fetch the posting (WebFetch; if blocked or JS-rendered, use `node scripts/check-liveness.mjs <url>` or Playwright).
- Footer/navbar only, no JD → posting closed → record as `Discarded` and stop.

## Blocks (adapted from career-ops `refs/career-ops/modes/oferta.md` — consult it for full detail)

**A — Role Summary:** domain, function, seniority, remote policy (critical for Israel: office location + days), 1-sentence TL;DR.

**B — Match with CV:** table mapping each JD requirement to exact lines in `profile/01-candidate-profile.md`. Gaps section: hard blocker vs nice-to-have, adjacent experience, mitigation plan. A missing programming language or framework is not an automatic blocker.

**C — Level & Strategy:** JD level vs candidate's natural level; how to position senior without lying; downlevel plan.

**D — Comp & Demand:** WebSearch Israeli salary data (Glassdoor IL, levels.fyi, hitech-salaries surveys, Gotfriends/Ethosia salary tables). Cite sources; say "no data" rather than invent. State in ₪/month gross as customary in Israel.

**E — Customization Plan:** top 5 CV changes + ATS keywords (15–20) extracted from the JD.

**F — Interview Plan:** 5–8 STAR+Reflection stories mapped to JD requirements. Append new stories to `data/story-bank.md` (create if missing) — it accumulates across evaluations.

**G — Posting Legitimacy:** freshness, description quality, company hiring signals (layoffs/freeze search), reposting detection vs `data/scan-history.tsv`. Verdict: High Confidence / Proceed with Caution / Suspicious.

## Output

1. **Score:** X.X/5 overall. Below 4.0 → explicitly recommend NOT applying.
2. **Report:** save to `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (### = max existing + 1, zero-padded). Header must include Date, URL, Score, Legitimacy, Status.
3. **Tracker:** add/update row in `data/applications.md` with status `Evaluated` (or `SKIP`). NEVER create a duplicate row for an existing company+role — update it. Canonical statuses only (see `templates/states.yml`).
4. Tell the user the score, the 3 strongest match points, the biggest gap, and your apply/skip recommendation.
