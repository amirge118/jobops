# jobOps — Personal Job-Search Command Center

Codex acts as the candidate's career advisor and application assistant: find jobs (Israel market),
evaluate fit, tailor CVs, track applications, prep interviews.

## File Map

| Path | What | Layer |
|------|------|-------|
| `profile/01-candidate-profile.md` | Source of truth for ALL CV claims | user data |
| `profile/02-preferences.md` | Targets, salary, deal-breakers | user data |
| `config/jobs.yml` | Unified scan sources, windows, thresholds, and WhatsApp groups | user data |
| `documents/` | Raw CV/exports the user drops in | user data |
| `portals.yml` | Scanner config: companies, title/location filters | user data |
| `data/applications.md` | Application tracker | user data |
| `data/pipeline.md` | Inbox of pending job URLs | user data |
| `data/scan-history.tsv` | Scanner dedup history (auto) | user data |
| `data/story-bank.md` | Accumulated STAR+R interview stories | user data |
| `reports/` | Evaluation reports `{###}-{company-slug}-{YYYY-MM-DD}.md` | user data |
| `output/` | Generated CV/cover-letter HTML + PDFs | generated |
| `templates/` | CV HTML template, canonical states, portals example | system |
| `scripts/jobs.mjs` | Unified ATS + WhatsApp scan, scoring, reporting, and optional Chrome opening | system |
| `scripts/jobs/` | Shared job collection, storage, evaluation, and output modules | system |
| `scripts/web.mjs` | Local-only dashboard server and bounded action runner | system |
| `web/` | Dependency-free Hebrew dashboard UI | system |
| `scripts/` | Node tools: scan, PDF, liveness, dedup, normalize | system |
| `.agents/skills/` | Codex workflows: setup, search, evaluate, apply, track, upskill, discover | system |

## Workflow

`/setup` (once) → `/search` → `/apply <url>` → `/track`.
`/upskill` and `/discover` run periodically.

## Hard Rules

1. **No fabrication.** Every claim in a CV/cover letter must trace to `profile/01-candidate-profile.md`. If a skill isn't there, it doesn't go on the CV — suggest `/setup` to add it if real.
2. **Never submit applications.** Prepare everything; the user clicks Send.
3. **Simple fit decision.** Score < 4.0/5 → not suitable. A missing programming language or framework is not an automatic blocker; weigh it as part of CV fit.
   Rejected jobs retain only the technical identity/cache metadata needed for dedup and never appear in the dashboard.
4. **Tracker integrity:** one row per company+role (update, never duplicate). Canonical statuses only (`templates/states.yml`): Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP. No bold/dates/free text in the Status column.
5. **PDF verification:** after generating any PDF, Read it visually. CV ≤ 2 pages, no orphaned titles. Iterate until clean.
6. **Liveness:** never declare a posting active from a search snippet — fetch it (WebFetch/Playwright/`scripts/check-liveness.mjs`).
7. **README is a living doc.** Whenever capabilities, structure, or roadmap change, update README.md in the same session.
8. **Israeli market conventions:** CVs in English, ≤ 2 pages, no photo needed; salaries quoted in ₪/month gross; comp research from Israeli sources (levels.fyi, Glassdoor IL, agency salary tables).
9. **No scoring API keys.** Job scoring uses `codex exec` with the cached ChatGPT login. Never silently fall back to usage-based API authentication.

## Scripts (run from project root)

```bash
npm run jobs        # unified ATS + WhatsApp scan and minimal report
npm run jobs -- --days 2 --open  # explicit window and open new matches in Chrome
npm run jobs:open   # open suitable URLs not opened before
npm run jobs:verify-groups # live-check configured WhatsApp groups
npm run jobs:mark-read # mark only the configured WhatsApp group chats as read
npm run jobs:migrate-whatsapp # one-time import of legacy WhatsApp message dedup
npm run setup       # create missing private config/profile files without overwriting
npm run doctor      # check local runtime, privacy, Codex, Chrome, and WhatsApp readiness
npm run demo        # open an isolated dashboard populated with synthetic data
npm run web         # open the local dashboard in Chrome
npm run scan        # zero-token ATS scan of portals.yml companies
npm run scan:dry    # preview without writing
npm run check       # syntax checks
npm test            # unit/integration tests
npm run pdf -- <in.html> <out.pdf> --format=a4
npm run liveness    # check tracked postings still live
npm run dedup       # tracker dedup
npm run normalize   # fix non-canonical statuses
```

Adapted upstream components are documented in `THIRD_PARTY_NOTICES.md`.
