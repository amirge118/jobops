---
name: statistics
description: jobOps weekly statistics review — what each source (ATS, WhatsApp groups, LinkedIn searches, HireMeTech) really brought, where jobs arrived first, how the score agreed with the person's decisions, outcomes and follow-ups, data quality, system health, and a retention (history-deletion) proposal; then concrete recommendations to add, change or drop, applied only with approval. Reads the report the scheduled Sunday 08:15 run stored (also sent as a WhatsApp summary). Use when the user asks "/statistics", "סטטיסטיקה", "דוח שבועי", "מה למדנו השבוע", "איזה מקור הכי טוב", "איפה המשרות מגיעות מהר", "מה כדאי לשפר", or replies to the weekly WhatsApp summary.
---

# /statistics — the weekly review, in full, and acting on it

Read-only until the user approves a specific change. Never send LinkedIn requests to "check" (each one
counts against its hourly limit), never touch `auth/`, never delete history without an explicit yes.

## 1. Load the report (no tokens)

```bash
npm run -s jobs:stats:weekly -- --print           # the latest stored weekly report (snapshot + analysis)
npm run -s jobs:stats:weekly -- --fresh --print   # a new snapshot right now; stores and sends nothing
```

The scheduled run (`com.amirgefen.jobops.weekly-stats`, Sunday 08:15, `npm run jobs:schedule:install`)
stores one row per week in `weekly_reports` and queues the WhatsApp summary (`weekly:<date>` in
`notification_outbox`). If the latest report is older than 7 days, or the user asks about "now", use
`--fresh`. `status: "fallback"` means Codex was unavailable — do the analysis yourself from the snapshot.

## 2. Present — Hebrew, numbers first, week vs. `previous`

Walk the sections in this order, each with its numbers and one line of meaning:

1. **Headline + key numbers:** suitable found, interesting (applied/interested), decisions — with the
   delta from `snapshot.previous.numbers`.
2. **Sources:** `decisions.sourceValue.yield` (found → filtered → scored → suitable → interested,
   tokens per fit, scan time) and `exclusivity` (what only this source found). Rank by value per token.
3. **WhatsApp groups:** `whatsappGroups[]` — messages (week/month) and, from `labelsSince` on, jobs /
   suitable / interesting. A configured group with messages but no suitable job in 30 days → drop
   candidate; one with no messages at all → check it is still joined (`npm run jobs:verify-groups`).
4. **LinkedIn searches:** `linkedinSearches[]` — yield per search, `lastStatus` (`capped`,
   `hourly_limit`), uncovered `gaps`. Searches share 10 requests an hour; splitting does not add requests.
5. **ATS companies:** `decisions.sourceValue.companies` (top producers, silent ones → weekly scan),
   `decisions.speed.coverage.topUnwatched` (interesting companies not scanned → add).
6. **Speed:** `decisions.speed` — LinkedIn publish→seen lag, first-seen comparisons between sources,
   found→decision latency. Say where the delay really is (discovery vs. decision vs. WhatsApp batching).
7. **Score calibration:** `decisions.scoreBands`, `decisions.calibration` ("not relevant" / "too senior"
   despite a high score). Note the `criteriaVersion` and whether the last gate changed the rates.
8. **Outcomes:** `outcomes` — applied vs. responded/interview; `followUpsDue` → offer `/track`.
9. **Data quality:** `quality.unknownCompanyShare`, `noSource`, `failureCodes`, `hiremetech`
   (resolved vs. failed; `signedOutAt` newer than `lastResolvedAt` ⇒ `npm run jobs:hiremetech-login`).
10. **Health:** `health.open`, opened/resolved this week, `signals` — for anything broken, hand off to `/pulse`.
11. **Learning focus:** `gaps` (top resume-gap topics) → `/upskill` for a plan.
12. **Retention:** `retention[]` — rows and MB per category, with why it is or is not worth deleting.
13. **Recommendations and app improvements:** from `analysis`, checked against the numbers. Add your own
    where the numbers show something the analysis missed.

## 3. Act — one approved change at a time

Offer each recommendation as a concrete change and apply it only after the user says yes:

| Recommendation | Change |
|---|---|
| Add / drop a WhatsApp group | `config/jobs.yml` `sources.whatsapp.groups` (jid from `npm run jobs:list-groups -- --pause-collector --filter TEXT`), then `launchctl kickstart -k gui/$(id -u)/com.amirgefen.jobops.whatsapp-collector`. The dashboard reloads the config by itself. |
| Change / add a LinkedIn search | `config/jobs.yml` `sources.linkedin.searches` (changing keywords restarts that search's coverage). |
| Watch a company | Companies page "add", or a `portals.yml` entry; the daily resolver handles candidates. |
| Scoring rule / threshold | `scripts/jobs/score-job.mjs` hard caps or `config/jobs.yml` `decision.*`; bump `criteriaVersion`. |
| Follow-ups | `/track`. |
| App bug / improvement | Explain the evidence; fix only if the user asks, with tests. |

### Retention — proposal first, then only on an explicit yes

```bash
npm run -s jobs:stats:prune                                   # dry run: categories, rows, MB
npm run -s jobs:stats:prune -- --apply --only page_content    # only what the user approved
```

Categories (`RETENTION_CATEGORIES` in `scripts/jobs/weekly-stats.mjs`): `page_content` (page text of
rejected/archived jobs > 30 days; re-fetchable), `linkedin_postings` (archived > 60 days),
`collector_events` (> 30 days). Job identities, decisions, sightings, source labels, WhatsApp message
dedup, HireMeTech targets and the tracker are never deleted.

## 4. Close

End with what was changed (and what was only proposed), and when the next weekly report runs (Sunday 08:15).
