---
name: apply
description: Tailor the CV (and cover letter) to a specific job, render verified PDFs, update the tracker. Drafter-reviewer workflow.
---

# /apply — Tailored application package

Input: job URL or company name already in the tracker. If not yet evaluated, run /evaluate first — never tailor a CV without a fit report.

## Workflow (drafter → reviewer → iterate)

1. **Load context:** the evaluation report from `reports/`, `profile/01-candidate-profile.md`, ATS keywords from the report.

2. **Draft (CV):** fill `templates/cv-template.html` placeholders:
   - Select experience bullets by **relevance to this JD** (score each bullet on fit + uniqueness, not recency).
   - Rewrite the summary for the role using JD language. Weave in ATS keywords naturally.
   - **Every claim must be backed by the profile — no fabrication, no inflation.**
   - **Core Competencies tags:** aim for a full last row, not a sparse 1–2 tag orphan under a fuller
     first row (the tag row is `flex-wrap`, so an uneven count reads as visibly unbalanced — see
     Step 5 for the check). Default: **prefer filling out a full second row** by pulling 1–2 more
     genuine tags from unused JD/ATS keywords or profile skills not yet represented — more tags also
     means more ATS keyword coverage. Only shorten/trim down to a single tight row if no more
     genuinely relevant tags exist to add.
   - Save as `output/{company-slug}/cv-{company-slug}.html`.

3. **Draft (cover letter, if requested or the posting asks for one):** ~250–350 words, addressed to the hiring manager if findable, one concrete company-specific hook (verified via WebSearch — don't trust memory), one proof story, one gap-mitigation if needed. Save HTML alongside the CV.

4. **Review pass:** act as a separate skeptical reviewer: research the company (WebSearch), then check the draft against the Verification Checklist below. Revise until clean.

5. **Render PDF:** `node scripts/generate-pdf.mjs output/{slug}/cv-{slug}.html output/{slug}/cv-{slug}.pdf --format=a4`
   Before the visual read, run `node scripts/check-competency-rows.mjs output/{slug}/cv-{slug}.html --format=a4` — it renders the actual tag layout and reports `OK` or `ORPHANED: row N has only X tags vs ... Y`. On `ORPHANED`, add 1–2 more genuine tags (default) or trim to one row if none are left, then re-run until `OK`.
   Then **Read the PDF visually** and verify: max 2 pages, no orphaned job titles at page bottom, no broken layout. Trim/iterate until it passes.

6. **Tracker:** update the row in `data/applications.md`: PDF ✅, note "package ready". Status stays `Evaluated` — it becomes `Applied` only after the user actually submits and says so.

7. **Hand off:** give the user the PDF paths and draft answers for any application-form questions. **NEVER submit anything yourself.**

## Verification Checklist (all must pass)
- [ ] Every claim traceable to `profile/01-candidate-profile.md`
- [ ] Contact details, titles, dates, company names correct
- [ ] Summary tailored to this role (not generic); key JD requirements addressed
- [ ] ATS keywords from the report present naturally
- [ ] No spelling/grammar errors (English CV is the Israeli tech standard)
- [ ] PDF ≤ 2 pages, visually inspected
- [ ] Core Competencies tags fill each row completely — no orphaned 1–2 tag last row (checked via `scripts/check-competency-rows.mjs`)
- [ ] Cover letter ≤ 1 page, company facts independently verified
