---
name: search
description: Scan ATS boards and configured WhatsApp groups, score new jobs, and show the minimal matching report.
---

# /search — Find matching jobs

Arguments are optional. Use `--days N` for an explicit lookback window. The default is the last
successful run with overlap, or two days on first use.

## Steps

1. Run `npm run jobs -- --days 2 --open` from the project root for an interactive search.
2. Read `reports/daily/latest.md` and present its minimal table without adding extra columns.
3. If the run fails, report the concrete source or setup error; do not silently replace it with
   unrelated web searches.

For diagnostics, narrow the source with `--ats-only` or `--whatsapp-only`. Use `--dry-run` when
the user asks for a preview that should not update local scan state.

## Rules

- Keep the decision simple: suitable or not suitable, with `בול מתאים` as a high-score label.
- A missing programming language or framework is not an automatic blocker.
- Do not present a job as active until the page liveness check passes.
- Do not show or open the same job again after it was recorded as presented/opened.
- Never submit an application; the user reviews each opened page and submits manually.
