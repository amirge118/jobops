---
name: track
description: View and manage the application pipeline — statuses, follow-ups, hygiene.
---

# /track — Pipeline management

Input (optional): a status update like `/track applied to Wiz` or `/track Gong rejected`, or nothing for an overview.

## Overview mode (no args)
Read `data/applications.md` and present:
- Pipeline summary: count per status (Evaluated / Applied / Responded / Interview / Offer / Rejected / Discarded / SKIP)
- Active items needing action: Evaluated with score ≥ 4.0 not yet applied; Applied > 10 days with no response (suggest follow-up); upcoming interviews
- Recent activity (last 5 changes)

## Update mode
- Update the existing row's Status (canonical states only — `templates/states.yml`), add date context to Notes.
- NEVER add a duplicate row for an existing company+role.
- When a status changes to `Rejected`, ask one short question about the stage it died at and record it — this feeds pattern analysis.

## Hygiene (run when asked or when the tracker looks messy)
- `node scripts/normalize-statuses.mjs` — fix non-canonical statuses
- `node scripts/dedup-tracker.mjs` — remove duplicate rows
- `node scripts/check-liveness.mjs` — verify open applications' postings are still live

## Canonical states
`Evaluated → Applied → Responded → Interview → Offer` plus terminal `Rejected / Discarded / SKIP`.
No bold, no dates, no free text in the Status column.
