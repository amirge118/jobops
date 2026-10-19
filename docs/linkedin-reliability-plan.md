# LinkedIn reliability plan

Status: phase 0 done (2026-10-19); conservative pacing live; phase 1 next. Owner: the jobOps maintainer.

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
