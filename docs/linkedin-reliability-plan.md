# LinkedIn reliability plan

Status: phase 0 done (2026-10-19); conservative pacing, the shared hourly cap and the queue reader
are live (phase 2 items 1–2, 2026-10-20); review options 1–3 (pre-read hint filter, stale archive,
retry once after a 429) live since 2026-10-24, egress switched to the direct connection the same day;
phase 1 measurements next. Owner: the jobOps maintainer.

## Problem

Most WhatsApp group links point to LinkedIn postings, and jobOps reads them through LinkedIn's public
guest endpoints (`jobs-guest/jobs/api/jobPosting/{id}` and the guest search). Since 2026-10-12 almost
every run is refused (`429` → `rate_limited`, sometimes a sign-in page → `blocked`) after 1–4
requests, and about 180–200 postings wait as `linkedin_deferred`.

Constraints that do not change:

- No login, no LinkedIn session, no proxies or IP rotation, no CAPTCHA solving. A refusal means stop.
- Traffic leaves through Cloudflare WARP (`warp=on`, `gateway=on`, team `fnxvpn`), i.e. a shared
  Cloudflare address. Whether WARP may be disconnected is the owner's decision, not the code's.

## How requests are made today (why it fails)

- Every run that meets a LinkedIn link reads postings itself: WhatsApp backlog runs (up to every 30
  minutes), the three daily WhatsApp scans, LinkedIn scans every 2 hours and retries. Each has its own
  budget of 40 posting reads, paced 2–4 s apart (`maxDetailFetchesPerRun`, `detailDelayMs`).
- After a refusal every reader stops for a fixed 1 hour (`linkedin_state.blocked_until`), then the
  next run bursts again at 2–4 s and is refused within a few requests.
- Nothing records individual LinkedIn requests, so the accepted rate was never measured.

## Hypotheses

- H1: The refusals are a short-term rate limit on request bursts, not a lasting block of the address.
- H2: A fixed interval between requests exists at which LinkedIn keeps answering, even through WARP.
- H3: A single, globally paced reader (one queue, one rate, shared by every source) can drain the
  backlog and keep up with new links without refusals.
- H4: After a refusal, a growing back-off recovers faster overall than a fixed hour followed by bursts.

## Phase 0 — one-request canary (done)

Tool: `npm run jobs:linkedin-canary` (`scripts/jobs/linkedin-canary.mjs`). One posting request per
run, records HTTP status, classification, `Retry-After`, latency and the WARP flags (never the IP) to
`data/linkedin-canary.jsonl`; refuses to run within 30 minutes of the previous record unless
`--force`. `--report` summarizes the log per egress.

Evidence (2026-10-19, through WARP, while jobOps' own cooldown after a 429 at 13:30Z was active):

| Time (UTC) | Mode | Result |
|---|---|---|
| 13:42 | single | 200 ok |
| 13:43–13:47 | series, 60 s apart | 5 × 200 ok |

Reading: H1 supported — 12 minutes after a refusal the same address is answered normally. The
fixed hour of cooldown is longer than needed, and the bursts that follow it are what trip the limit.

Follow-up the same afternoon:

| Time (UTC) | What | Result |
|---|---|---|
| 13:55 | `--retry-only` run, first posting 4474056095 | 200, no description → classified `blocked`, whole run halted |
| 13:56 | canary on 4474056095 | 200, 16.7 KB page without a description: a posting-level problem |
| 13:57–13:58 | `--retry-only` run after the fix below, 60 s pacing | posting 1 `structure_changed` (run continued), posting 2 → 429 |

- **Bug fixed:** a 200 posting page without a description was read as a sign-in block because every
  public page contains "Sign in" / "Join now". One odd posting at the head of the retry queue halted
  every run and started a cooldown. A 200 page now counts as a block only when LinkedIn redirected to
  a sign-in URL (`scripts/jobs/fetch-page.mjs`, regression test in `tests/jobs-fetch-page.test.mjs`).
- **H2 revised:** 60 s pacing passed on an idle window but was refused after ~10 requests in 17
  minutes (canaries, both verification runs and the 13:30 scheduled LinkedIn scan). The limit looks
  like a request count per time window, not only a minimum gap. Production config was lowered to 6
  postings per run, 2–3 minutes apart, 20-minute cooldown, 2-minute gap after activity.

Phase 1 therefore measures a budget per window, not the fastest interval.

## Review after four days of the hourly cap (2026-10-20 → 23)

Data: `linkedin_requests` (every request and every refusal, with the load before it) and the
scheduled logs.

- **Refusals are rare and barely depend on load.** 8 refusals in 463 requests (1.7 %). The first
  request in any 10-minute window was never refused (0/103); every further request carried a 2–4 %
  risk whether it was the 2nd or the 5th. Refusals came at loads as low as 3 requests an hour. With
  traffic leaving through a shared Cloudflare WARP address, part of this is other people's traffic.
- **The cost of a refusal is our own policy:** the run stops, everything after it is deferred and a
  20-minute cooldown starts. Other projects wait `Retry-After` (or 30–45 s) and retry once.
- **We are 30–90× slower than others who read the same endpoints.** Published setups read details
  2–4 s apart (or ≤ 1 request/s) for hundreds of postings a day; one project hit 429s at ~500
  detail fetches a day and fixed it with 4 s delays plus `Retry-After`. We read one posting every
  2–3 minutes and at most 10 requests an hour.
- **Throughput, not blocking, is the limit now.** 130–150 new LinkedIn postings a day (half from the
  LinkedIn search, half shared on WhatsApp) against 80–120 posting reads. Fresh postings are read
  the same day (newest first); the queue is leftovers: 53 aged 1–3 days, 48 aged 3–7, 80 older than
  a week.
- **Most reads are wasted.** In the queue reader's runs, 157 postings were thrown away after being
  read (123 by the title filter, 30 by blocked companies, 4 duplicates) against 28 that reached
  scoring — about 85 %. WhatsApp links arrive without a title or company (176 of 181 queued
  postings have neither), although the messages usually carry the title (e.g. a bold first line),
  and the message text is erased after URL extraction, so the filter can only run after the read.

### Options, by expected effect

1. **Read less — filter WhatsApp links before reading.** At ingestion, keep a title/company hint
   from the message (bold first line, "X is hiring Y", the raw URL slug
   `/jobs/view/<title>-at-<company>-<id>`) on the job, and apply the title filter and blocked
   companies before queueing. Expected: most of the ~85 % wasted reads disappear.
2. **Drop stale postings without reading them.** Postings queued more than N days (e.g. 5) are
   closed as stale instead of read; fresh postings are what matter.
3. **Handle a refusal like others do.** Record status and `Retry-After` with each refusal; on a 429
   wait `Retry-After` (or ~45 s) and retry once; only a second refusal or a sign-in page / 999
   stops the run and starts the cooldown.
4. **Speed up step by step, measured.** Lower `detailDelayMs` (120–180 s → 30–45 s) and raise
   `maxRequestsPerHour` gradually (10 → 20 → 30), each step for two days, keeping the refusal rate
   under 3 % in `/pulse`.
5. **Egress (owner's decision).** A direct home connection instead of the shared WARP address;
   the canary log keeps the two apart for comparison.
6. **Alternative source (decision: needs mail access).** LinkedIn's own job-alert e-mails carry
   job ids, titles and companies without any request to LinkedIn.

## Options 1–3 live, and the egress comparison (2026-10-24)

- First queue-reader run with the new rules: 91 postings older than 5 days archived unread; the
  queue went from 120 to 28. A 429 at 11:53 (no `Retry-After`) was waited out for 45 s, the retry
  returned 200 and the run went on; the hourly cap then deferred the rest, as designed.
- **The direct connection is refused far more often than WARP.** WARP was disconnected on
  2026-10-23 around 17:00 (its route log goes quiet). In the ~30 hours before, through WARP, one
  request was refused; in the 18 hours after, on the direct home connection, 16 of ~95 were
  refused (~17 %), almost one every hour. A single canary over the direct connection right after
  the switch succeeded, so this is a rate, not a block. The correlation is in time only; whether the
  organization's WARP may be used for this is the owner's decision.
- The hint filter applies to links collected from now on; the queue still held links without hints.

## Phase 1 — measure the accepted budget per window (small, bounded tests)

First let the conservative production config run on its own schedule for a day; its refusals (or
their absence) are the baseline. Then, on a quiet window (no LinkedIn request in the previous 60
minutes), use `--series N --interval S` (at most 10 requests, stops at the first refusal):

| Step | Command | Pass criterion |
|---|---|---|
| 1a | `--series 10 --interval 120` (10 requests / 18 min) | 10/10 ok |
| 1b | after ≥ 60 quiet minutes: `--series 10 --interval 60` (10 / 9 min) | 10/10 ok |
| 1c | right after 1b passes: one more `--series 5 --interval 60` | shows whether ~15 per 15 min is over the limit |
| 1d | repeat the best passing step at another time of day | 10/10 ok |

Result: the largest request count per 15- and 60-minute window that passed every repetition.
Production uses half of it. Also note any `Retry-After` value — it would replace guessed cooldowns.

Optional, only if the owner may disconnect WARP: run step 1a once with `warp=off` to see whether the
egress changes the picture. The log keeps the two egresses apart.

Expected evidence to record here: a table of every series (time, interval, ok/total, first refusal).

## Phase 2 — product changes (only after phase 1 passes)

1. **One LinkedIn gate for every request.** A small module that every LinkedIn read goes through
   (search pages and postings), across processes, using SQLite (`linkedin_state`) for the shared state:
   - minimum gap between any two LinkedIn requests = production interval from phase 1, with ±20%
     jitter;
   - hourly and daily caps (initially `3600 / interval / 2` per hour and 300 per day);
   - after a refusal: stop, then back off 15 min → 30 min → 1 h → 2 h → 4 h (cap 12 h); one
     successful request resets the ladder. `Retry-After`, when present, wins.
2. **One reader drains the queue.** Runs stop reading LinkedIn postings themselves; they only enqueue
   (the `linkedin_deferred` state already exists). One scheduled job reads queued postings through
   the gate — newest first, because fresh postings matter most — and processes them like any other
   job.
3. **Read less.** Before queueing, apply the existing title filter to the WhatsApp message text, so
   postings that are clearly not target roles are never requested (yesterday the title filter dropped
   155 jobs only after their pages were read).
4. **Observe.** A `linkedin_requests` table (time, kind, HTTP status, result, egress flags), 14 days of
   history, and health findings for: refusal rate > 10% in 24 h, any back-off ≥ 4 h, oldest queued
   posting > 24 h.

Each change ships with tests; the gate gets negative tests for: parallel processes respecting the
shared gap, caps, the back-off ladder and its reset, and no request while backing off.

## Phase 3 — rollout and acceptance

- Ship with the production interval from phase 1 and the caps above.
- Acceptance over 3 consecutive days with the Mac on power: refusal rate ≤ 5%, the deferred queue
  shrinks every day until it is empty, no posting waits more than 24 h, and no back-off longer than
  1 h.
- If refusals persist at the measured interval, double the interval and repeat; if they persist at
  ≥ 5 minutes, LinkedIn's guest endpoints are not usable from this egress and LinkedIn job alert
  e-mails become the alternative source (separate decision: needs mail access).

## Limitations

- LinkedIn's limits are undocumented and may change; the canary log and the request table exist so a
  change is visible within a day.
- WARP's shared egress can be throttled for reasons outside jobOps (other users of the same address).
- Automated reading of LinkedIn's guest pages is still subject to LinkedIn's terms; jobOps keeps the
  volume personal and stops on every refusal.
