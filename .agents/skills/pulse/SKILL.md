---
name: pulse
description: jobOps system pulse — is anything broken right now, why, what to do about it, and how many jobs were read recently (per source, LinkedIn requests, WhatsApp messages). Read-only, token-free data collection, then a diagnosis that ties each problem to its cause and a concrete action. Use when the user asks "/pulse", "מה המצב", "יש תקלות?", "הכל עובד?", "מה קורה במערכת", "כמה משרות נקראו", or wants a quick health check of the whole system (not just the last scan — that is /scan-health).
---

# /pulse — the system's pulse: faults, causes, actions, and recent reads

Read-only. Diagnose and recommend; never change code, config, LaunchAgents, `auth/` or the jobs DB
without the user approving that specific change. Never send requests to LinkedIn to "check"
(every request counts against its limit) — the data already shows what LinkedIn answered.

## 1. Collect (one command, ~2 s, no tokens)

```bash
npm run -s jobs:pulse            # JSON snapshot + `signals`
npm run -s jobs:pulse -- --text  # the same, as a short summary
```

Sections: `services` (launchd agents, pid, last exit), `machine` (AC power, sleeps/dark wakes in
24h with local hours, WARP egress flags), `collector` (status, heartbeat, last message, reconnects /
connect failures / decrypt failures in 6h, last disconnect), `whatsapp` (group messages 1h/6h/24h,
backlog), `alerts` (WhatsApp alerts still deliverable vs. expired), `linkedin` (cooldown, last block,
queue by code, requests by kind in 1h/24h from `linkedin_requests`, busiest hour vs. the cap,
every refusal in 24h with the load before it, minutes since the last search, postings evaluated), `ats` (last scheduled run: companies vs. errors), `codex` (calls and failures
in 24h, quota), `runs` (stuck / running), `jobs` (evaluated in 24h per source with new suitable,
current failure codes), `health` (open findings of the hourly health check), `signals`.

If a section has `{ error }`, say so and read that part directly (sqlite3 on `data/jobs.db`).

## 2. Diagnose — every signal, using the playbook

Signals are pre-computed anomalies. For each one: confirm with the evidence named in the playbook,
name the cause, give the action. Also look for problems without a signal (e.g. a number that is
zero when it should not be). Check `logs/scheduled/<agent>.log` for the agent involved.

| Signal | Likely cause (seen before) | Confirm | Action |
|---|---|---|---|
| `collector.pairing_required` | WhatsApp logged the linked device out (2026-10-17, after 3 days unable to connect) | `collector.status`, last `connect` event | User re-pairs: stop the service, move `auth/browser` aside, unlink the old device on the phone, `npm run whatsapp:collector` in a terminal, scan the QR, then `launchctl kickstart gui/$(id -u)/com.amirgefen.jobops.whatsapp-collector`. Never delete `auth/`. |
| `collector.down` / `collector.stale_heartbeat` | process died or the Mac slept | `services` pid of `whatsapp-collector`, `machine.last24h` | `launchctl kickstart gui/$(id -u)/com.amirgefen.jobops.whatsapp-collector`; if it repeats, read the collector events of the run. |
| `collector.cannot_connect` | no network (Mac asleep / dark wake, WARP or DNS down — `ENOTFOUND web.whatsapp.com`), or WhatsApp refusing the device | `lastDisconnect`, `ats.mass_failure` at the same time ⇒ network | Network: check `curl -sI https://web.whatsapp.com`, WARP status. Persisting for hours without network problems ⇒ re-pair. |
| `whatsapp.silent` | connected but WhatsApp delivers nothing: an unanswered offline queue (decrypt failures left without a retry receipt) or an outdated Baileys | `collector.decryptFailuresLast6h`, Baileys version in package.json (7.x since 2026-10-19) | Diagnose with `JOBOPS_WA_LOG_LEVEL=warn` in a 3-minute foreground run (service stopped first) and count `failed to decrypt` by chat kind. Never stop Baileys answering undecryptable messages — that stalls the whole queue (2026-10-19 09:44–12:44). Re-pair if it persists. |
| `collector.flapping` | every ~50 min `Stream Errored (ack)` is normal; many more ⇒ network or session trouble | `lastDisconnect.stream`, `connectFailuresLast6h` | Normal pattern: nothing. Otherwise as `cannot_connect`. |
| `collector.decrypt_failures` | old messages after a re-pair / LID sessions | decrypt-failure details in `collector_events` (chat kind, error) | Right after a re-pair: expected, fades. Tracked-group failures that persist ⇒ investigate. Phone shows "syncing with Google Chrome (Ubuntu)" ⇒ these retries; `shouldIgnoreJid` already drops untracked chats. |
| `whatsapp.backlog_waiting` | `whatsapp-trigger` waits for enough jobs, or its runs fail | `logs/scheduled/whatsapp-trigger.log` last lines | Normal if "waiting_for_more"; otherwise read the error. |
| `alerts.unsent` | collector not connected, so WhatsApp alerts cannot leave | `collector.status` | Fix the collector. macOS notifications cover new findings meanwhile. `alerts.expired` is history only. |
| `linkedin.cooldown` | a recent 429 (`rate_limited`) or sign-in page (`blocked`) | `lastBlock`, busiest hour vs. `hourlyCap` | Wait; never run LinkedIn manually during a cooldown. Repeated blocks under the cap ⇒ lower `limits.maxRequestsPerHour` in `config/jobs.yml` (see docs/linkedin-reliability-plan.md). |
| `linkedin.over_cap` | something sends LinkedIn requests outside the shared gate | `linkedin_requests` per hour and kind | Find the caller (canary runs are not logged there), fix the code path. |
| `linkedin.refusals` | rate limit, or a posting page misread as a block (fixed 2026-10-19: 200 pages count as blocked only by a sign-in URL) | job codes, `linkedin_requests` around the block | Rate limit ⇒ as cooldown. One posting always failing ⇒ it is that posting. |
| `linkedin.queue_stalled` | `linkedin-queue` agent missing or failing, the hourly cap always used up by other runs, or cooldown never ending | `services` (`linkedin-queue`), `logs/scheduled/linkedin-queue.log` | Reinstall with `npm run jobs:schedule:install`; if the cap is always full, look at who uses it. |
| `linkedin.refusals_recovered` | info: a 429 was waited out (`Retry-After` or 45 s) and the one retry succeeded — the policy since 2026-10-24 | `linkedin.requests.refusals[].recovered` | Nothing. Many of them in an hour ⇒ treat as `refused_under_cap`. |
| `linkedin.refused_under_cap` | LinkedIn tolerates less than `maxRequestsPerHour`; on 2026-10-20 it refused the 3rd of 3 requests 2–3 minutes apart with only 6 in the hour | `linkedin.requests.refusals` (each with requests in the hour / 10 minutes before it) | Spread requests more (wider `detailDelayMs`, fewer per queue run) or lower the cap — propose the numbers from the refusal evidence; do not apply without approval. |
| `linkedin.search_starved` / `health.linkedin-search` | searches need several requests in a row and meet a cooldown or a 429 caused by the queue reader's postings just before (2026-10-20 10:30: 6 postings 10:00–10:13, then the search's first request → 429) | `linkedin.requests.lastSearchMinutesAgo`, `logs/scheduled/linkedin.log` (`cooldown` / `הגביל`), requests before each scan slot (:30 of even hours) | Keep the queue reader away from scan slots (e.g. skip queue runs in the 30 minutes before a scan) or give it fewer requests per hour; a plain cooldown resolves by itself and coverage resumes from the last success. |
| `ats.mass_failure` | the run fired without network (dark wake after sleep, WARP/DNS) | `machine.last24h`, same-time collector failures | Mac on power and awake; transient if the next run is fine. |
| `ats.not_running` | `scan-ats` agent not loaded, or every run skipped on the scan lock | `services`, `logs/scheduled/ats.log` | Reinstall schedules; check for a long run holding the lock. |
| `codex.quota` / `codex.failures` | Codex limit reached, or timeouts (300 s) | `codex.lastFailure` | Quota: wait (runs skip by themselves). Repeated timeouts: check `codex` login and network. Never switch to API keys. |
| `runs.stuck` | the process was frozen (Mac slept mid-run) or killed | heartbeat age, `machine.last24h` | Usually clears after the process dies; the next check resolves it. |
| `service.not_loaded` / `service.last_exit_failed` | agent never installed, or its last run crashed | the agent's log | `npm run jobs:schedule:install` (scans) or the service's own install script; read the crash in the log. |
| `machine.on_battery` / `machine.slept` | the Mac slept while runs were scheduled | `sleepHoursLocal` | Keep it on power during the day; sleep at night is fine. |
| `jobs.none_read` | everything above failed at once — usually network or Codex | other signals | Fix the upstream cause first. |
| `jobs.unknown_source` | suitable jobs saved with an empty `sources_json` and no sighting (seen 2026-10-20: hiremetech.com links) — the decisions page cannot say where they came from | `SELECT canonical_url, sources_json FROM jobs WHERE first_suitable_at >= …` | Data bug to investigate in the code path that saves sources; report it, do not patch rows by hand. |
| `network.warp` | info: traffic exits through Cloudflare WARP (team `fnxvpn`) | — | No action; relevant only to LinkedIn limits. |
| (egress change) | LinkedIn's refusal rate depends on the egress: through WARP ~0.5–1 % (2026-10-20→23), on the direct home connection ~17 % per request (2026-10-23 17:00 → 10-24, refusals almost every hour) | `machine.egress`, `linkedin.requests.refusals` before/after the change; WARP state changes in `/Library/Application Support/Cloudflare/cfwarp_route_change_log.txt*` | Report the comparison; whether WARP (an organization VPN) may be used is the owner's decision. |
| WhatsApp quiet on Shabbat | the groups barely post from Friday afternoon to Saturday evening | `whatsapp.groupMessagesLast24h`, the weekday | Expected: `whatsapp.silent` and the health check's `whatsapp:silent` skip Friday 15:00 – Saturday 21:00 (Israel). |

Unknown signal or a pattern not in the table: investigate it from code and data (scripts in
`scripts/jobs/`), and then add a row here (see §4).

## 3. Report — in Hebrew, short, outcome first

1. **One line**: everything works / what is broken right now.
2. **מה נקרא לאחרונה** (24 h): jobs evaluated per source and new suitable; WhatsApp group messages;
   LinkedIn requests actually sent (postings / searches) vs. postings evaluated, queue size and its
   direction if known.
3. **תקלות** — a table: מה | למה (cause, with the evidence) | מה לעשות | דחיפות. Errors first.
   Skip `info` signals unless they explain something.
4. **מה לא צריך לעשות** when relevant (e.g. not to run LinkedIn manually during a cooldown).
5. Offer the concrete next step; ask before any change.

## 4. Improve this skill

When a run of /pulse misses a problem, misreads a number, or meets a new failure pattern: fix the
collector (`scripts/jobs/pulse.mjs`, with a test in `tests/jobs-pulse.test.mjs`) and add or correct
the playbook row above, in the same session. Keep `.agents/skills/pulse/SKILL.md` identical.
