---
name: upskill
description: Analyze skill gaps across all evaluated jobs and suggest a focused learning plan.
---

# /upskill — Skill-gap analysis

## Steps

1. **Aggregate gaps:** read all reports in `reports/` and extract every Block-B gap and missing ATS keyword. Count frequency across postings.

2. **Rank:** which missing skills appear most often in jobs the user actually wants (score ≥ 4.0)? Separate:
   - **Quick wins** — learnable in days/weeks (a tool, a framework, a cert)
   - **Strategic gaps** — months (a new domain, leadership scope)
   - **Ignorable** — appears rarely or only in low-score postings

3. **Plan:** for the top 3 gaps, suggest concrete resources (course/docs/project idea) and — most effective — a small portfolio project that demonstrates the skill and becomes a CV bullet.

4. **Persist:** write/update `data/upskill-plan.md` with the analysis date, ranked gaps, and chosen actions. On re-runs, show progress vs the previous plan.

## Rules
- Tie every recommendation to actual postings ("appears in 6 of 9 evaluated roles"), not generic career advice.
- A profile update (`/setup`) is the cheapest fix when the skill exists but isn't documented — check that first.
