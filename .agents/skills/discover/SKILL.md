---
name: discover
description: Launch parallel research agents to find new job sources, tools, and tactics that improve the search. Feeds the README roadmap.
---

# /discover — Continuous improvement research

## Steps

1. **Launch 3 parallel research agents** (single message, multiple Agent calls, WebSearch/WebFetch), each with one focus:

   - **Agent 1 — Sources:** new or under-used job channels for the Israeli market: niche boards, Telegram/WhatsApp job groups, VC portfolio job boards (e.g., OurCrowd, Team8, aMoon portfolio pages), community boards (Machine Learning Israel, Baot, etc.), recruiting agencies worth registering with. Also: companies on Greenhouse/Lever/Ashby not yet in `portals.yml`.

   - **Agent 2 — Tools & features:** what are similar OSS projects doing that jobOps doesn't? Check the upstreams (`MadsLorentzen/ai-job-search`, `santifer/career-ops` — releases/changelog since our clone) and other AI job-search tools. Identify 3–5 concrete features worth porting.

   - **Agent 3 — Tactics:** current best practices: ATS optimization changes, recruiter outreach templates that work, LinkedIn profile optimization, Israeli market hiring trends (which sectors hire now, salary movements).

2. **Synthesize:** merge findings, drop fluff, keep only actionable items with a concrete next step each.

3. **Update README.md → Roadmap:** add new items under "Ideas from /discover (YYYY-MM-DD)" with a one-line rationale each. Don't duplicate existing roadmap items; if a finding strengthens an existing item, note it there.

4. **Report to the user:** top 3 recommendations with effort estimates, and ask which to implement.

## Rules
- Findings must be specific (a named board, a named feature, a linkable source) — no generic advice.
- Never auto-implement; roadmap first, user decides.
