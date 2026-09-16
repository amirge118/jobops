# jobOps — technical reference

This is the full engineering deep-dive: every subsystem, edge case, and design rationale in
jobOps. Start with the [README](../README.md) for the short overview, screenshots, and quick
start — come here for the details behind how each piece actually works.

`portals.yml` currently contains 91 companies, with 73 active scanner sources and 18 saved for
later investigation. The latest sector expansion starts from 14 selected
fintech, gaming, revenue-tech, and Web3 companies and maps five close peers to each one. That
research covers 68 unique companies; after two source audits, 38 use verified ATS sources and
another 15 use bounded, same-origin official HTML rules. The remaining active sources include
reusable Workday, Zoho Recruit, and TeamMe adapters. See the full rationale and source audit in
[`company-expansion-research.md`](company-expansion-research.md).

## Why jobOps

Most job-search tools begin and end with public job boards. In the Israeli tech market, useful
roles also arrive through private WhatsApp communities and are easy to lose, reread, or evaluate
inconsistently. jobOps treats the search as one local pipeline: collect, normalize, deduplicate,
verify, explain the fit, and keep only the matches worth reviewing.

The project is intentionally local-first. Personal profiles, WhatsApp credentials, scan history,
reports, and application state never need to enter source control or a hosted database.

## Try the demo

The fastest way to explore jobOps uses synthetic companies, jobs, groups, and scan results. It
does not connect to WhatsApp, read a candidate profile, invoke Codex, or modify real job data.

```bash
git clone https://github.com/amirge118/jobops.git
cd jobops
npm ci
npm run demo
```

The demo shows source health, four suitable jobs, transparent score breakdowns, dedup-aware
archiving, and the same dashboard used by the real workflow.

jobOps never submits an application. It can open matching application URLs in Chrome, but the
candidate reviews and submits them manually.

## What the unified scan does

```mermaid
flowchart LR
    A["ATS boards"] --> C["Collect and normalize"]
    B["WhatsApp groups"] --> W["Persistent Collector"]
    W --> Q["Local SQLite inbox"]
    Q --> C
    C --> D["Deduplicate in SQLite"]
    D --> E["Verify page and score with signed-in Codex"]
    E --> F["Minimal Markdown report"]
    F --> G["Optional: open new URLs in Chrome"]
    E --> H["Review company candidate"]
    H --> R["Discover and probe exact job source"]
    R -->|"Explicit approval"| I["Persistent ATS watchlist"]
    I --> A
```

The decision stays deliberately small: `מתאים` or `לא מתאים`, with `בול מתאים` as the
high-score label. A missing programming language or framework can lower the score, but is not
an automatic blocker. Only basic incompatibilities such as an inactive posting, wrong role
domain, incompatible location, or missing application URL block a match.

The report stays intentionally minimal and contains only:

- company
- short job description
- score
- match label
- one decision reason
- application URL

## Quick start

Requirements: Node.js 22+, npm, Google Chrome, and Codex CLI signed in with ChatGPT. No model
API key is required. Playwright's Chromium is used only when a regular HTTP check cannot
determine whether a posting is active.

```bash
npm ci
npx playwright install chromium
npm run setup
codex login
npm run doctor
```

`codex login status` must report `Logged in using ChatGPT`. Fill in the two private profile
files and configure sources in `config/jobs.yml`. On macOS, jobOps automatically finds the
Codex binary bundled with the ChatGPT desktop app; `CODEX_BIN` is available as an override.

```bash
npm run jobs -- --dry-run --ats-only  # safe ATS preview
npm run jobs -- --days 2              # scan the last two days
npm run jobs -- --days 2 --open       # also open new matches in Chrome
npm run jobs:open                      # open matches that were not opened yet
npm run jobs:verify-groups             # confirm configured WhatsApp groups still exist
npm run whatsapp:collector             # keep receiving WhatsApp messages in this terminal
npm run jobs:import-whatsapp-links -- --group "GROUP" --file links.json # one-time browser/export backfill
npm run jobs -- --whatsapp-backlog --days 7 # process seven days already queued locally
npm run jobs -- --whatsapp-backlog          # process the next bounded history batch
npm run diagnostics -- --latest        # print the newest safe diagnostic record
npm run start:local                    # recommended: Collector + dashboard from macOS Terminal
npm run stop:local                     # stop only this project's dashboard
npm run restart:local                  # stop stale dashboard and start a clean one
npm run web                            # open the local dashboard in Chrome
```

On macOS, the simplest reliable launch is to double-click `start-jobops.command` in Finder. If
macOS blocks it the first time, right-click the file and choose **Open**. It starts the WhatsApp
Collector service when needed and opens the dashboard from Terminal, outside automation
sandboxes that can block Chromium or the signed-in Codex scorer. The equivalent manual command is:

```bash
cd /path/to/jobOps
npm run start:local
```

Use `restart-jobops.command` when the site is stale or a previous server still owns port `4177`.
Use `stop-jobops.command` when you want to shut down only the dashboard. Both commands verify that
the listener belongs to this jobOps checkout before signaling it, so they do not terminate unrelated
Node.js processes. The WhatsApp Collector is a separate background service and remains active after
the dashboard is stopped.

The dashboard runs only on `127.0.0.1:4177` and redirects `/` to three focused pages:

- `/scan` — run a scan, inspect source health, review per-group coverage, and diagnose failures.
- `/decisions` — review suitable jobs, open/archive them, and create company candidates.
- `/companies` — inspect the watchlist, resolve a careers URL, and explicitly approve sources.

All pages use the same SQLite store. A scan keeps running in the local server process when the
user moves between pages. Only one action can run at a time, and the scan page displays its live
output. Page-specific APIs avoid downloading jobs, companies, and diagnostic history everywhere.
It does not add a second database or duplicate the scanner's decision logic.
The architecture decision and its trade-offs are recorded in
[`docs/adr/0002-multi-page-dashboard.md`](adr/0002-multi-page-dashboard.md).

The scan page's WhatsApp section has two actions. **Process collected messages** evaluates links
already received during the last seven days. **Fill history gaps** stores the last collected
timestamp separately for every configured group, waits safely while the Collector is offline, and
asks the connected Collector to resume from those captured cursors. The group table shows the last
collection time and the latest received, linked, suitable, failed, and pending counts. WhatsApp may
decline a linked-device history request; this is reported per group as `history_no_response` rather
than being presented as an empty group. Pending message bodies older than seven days are erased while
their minimal deduplication identity is retained.

### Two-minute dashboard workflow

1. Run the scan and review only the suitable jobs.
2. Use **פתח והעבר לארכיון** to open a posting and remove it from the active list in one action.
   If Chrome blocks the new tab or archiving fails, the job remains active.
3. Use **בדוק חברה למעקב** on a useful WhatsApp/ATS result. jobOps inspects the final application
   URL (after a short-link redirect), identifies a supported job source, and saves a preview only.
4. Select **אשר והוסף למעקב** only when the preview is correct. The source joins the next scan.
5. Pause or ignore companies from the company table; `portals.yml` will not overwrite that choice.

The company page offers two explicit flows. **Research by name** runs a live web search through the
locally signed-in Codex CLI (ChatGPT login, no API key), collects up to five official or dedicated
career-source candidates, and then verifies them with deterministic provider code. It follows
bounded public redirects, detects supported ATS URLs embedded in official pages, and runs the real
provider before showing the result. The preview distinguishes verified jobs, a healthy empty board,
a blocked source, a failed source, and a page that still needs an adapter. It also shows up to three
sample jobs. The result remains a candidate until explicit approval. **Add a known URL** resolves
locally and deterministically without a network request. Supported public board URLs are
Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters, Comeet, Workday, Zoho Recruit,
TeamMe, and explicitly configured official HTML pages. Each hiring platform has one reusable
adapter; companies supply only a board URL and, when an acquired brand shares a Workday board,
an optional `search_text`. Official HTML rules use one bounded HTTP response, reject redirects, and
return only same-origin links matching the configured path shape. Other unsupported URLs stay
visible as candidates but cannot be approved until a supported source is known. Research input
and model output are length-bounded, all returned URLs must be public HTTPS URLs, only one research
run may execute at a time, and approval remains a separate user action. Untrusted discovery pages
have DNS/private-network checks, at most four redirects, a 15-second timeout, a 2 MB response limit,
and an HTML content-type check. Provider probes retain their existing host allowlists.

Company state and source verification are separate. `paused` remains a user/catalogue tracking
choice; source verification records `verified_jobs`, `verified_empty`, `blocked`, `failed`,
`needs_adapter`, `external_only`, or `stale`, together with a bounded reason and last observed job
count. This prevents a working board with zero openings from looking like a failed scan.

Dashboard read endpoints are deliberately small and local-only: `GET /api/summary`,
`GET /api/scan`, `GET /api/readiness`, `GET /api/jobs`, and `GET /api/companies`.
Company mutations remain
`POST /api/companies/research`, `POST /api/companies/resolve`, `POST /api/companies/:id/watch`, and
`POST /api/companies/:id/status`. Request bodies are bounded and validated; approval is idempotent,
and the browser never supplies provider or board identifiers for a watch decision.

### Understanding failures

The scan page checks readiness before starting: Chromium, the signed-in Codex scorer, and the
WhatsApp Collector. An ATS scan requires the first two; a WhatsApp scan requires all three. An
impossible scan is rejected before collecting hundreds of jobs. The newest result is presented as
one outcome with deduplicated root causes and a concrete next step. Per-source and per-group counts
remain available under **פירוט לפי מקור וקבוצה**, while only the run ID and safe failure codes are
shown under **פרטים לתמיכה**.

For example, `permission_denied` means the OS refused file access, `timeout` means a time limit
expired, and `coverage_incomplete` means WhatsApp did not prove that all messages in the time
window were received. None of these is a "not suitable" decision. ATS collection errors,
message-processing errors, failed read receipts and page/scoring failures make the run incomplete.
The diagnostics are operational evidence, **not an AI reasoning transcript**.

Each source summary is saved before starting the next source. A five-second heartbeat and
process ID help distinguish active work from an interrupted process. SIGINT/SIGTERM and uncaught
exceptions record a terminal event when storage is available. SIGKILL/power loss cannot record a
cause: on the next dashboard read, an absent recorded process is shown as interrupted with an
unknown cause. A stale heartbeat is unconfirmed, not proof of a crash; PID reuse can also make
process liveness ambiguous. Legacy unfinished scans without an owner PID remain unconfirmed.
Historical missing logs cannot be reconstructed. No old run is rewritten by this observation.

Diagnostics use the existing private `data/jobs.db`: `runs`, `run_events`, `action_runs`,
`collector_runs`, and `collector_events`. Retention runs at dashboard startup and after completed
scans/actions. It keeps detailed evidence for the newest three scans, actions, and Collector runs.
Older failed records are deleted. The latest successful run for each exact source set is retained
as a compact checkpoint without events or diagnostic payloads so incremental scan windows continue
to work. Job deduplication, WhatsApp message IDs and anchors, company state, and archived jobs are
never part of diagnostic cleanup.

Durable diagnostics never store raw subprocess output, QR codes, WhatsApp message bodies,
credentials, arbitrary exception text or full stack traces. Unclassified errors are explicitly
unknown rather than copied verbatim. The temporary live-output panel is separate and its limited
redaction is **not** a guarantee that arbitrary third-party output is safe to share. Share the
structured support details instead. If SQLite itself is unavailable, the UI/terminal reports a storage
failure; persistence cannot be guaranteed until permissions or disk space are fixed. A CLI failure
before opening SQLite/starting a run has no run record; dashboard-launched commands still have an
action record. External launchd failures before Node starts remain in the launchd logs.

The CLI command `npm run diagnostics -- --latest` prints the newest bounded technical record when
deeper support evidence is needed. Read-only detail endpoints remain available for the three recent
records and accept bounded numeric IDs only. The older `/api/state` endpoint remains available for
compatibility. After updating code, stop the old server with Ctrl+C and run `npm run web`
again (wait for any active scan to finish first). A browser refresh alone does not reload the Node server.

The source-health panel distinguishes "no new jobs" from a failed or incomplete collection run.
It reports ATS errors, WhatsApp message/link counts, configured groups found, and the last-run
result. Each matching job also has an optional score breakdown for CV fit, seniority, role scope,
location, sector, and remaining uncertainties. The Markdown report remains minimal.

Only suitable active jobs appear in the dashboard and reports. A rejected job keeps only its
canonical identity and cache hashes required to prevent duplicate work; its company, title,
description, score, decision reason, and source details are discarded.

### Persistent WhatsApp collection

Run `npm run whatsapp:collector` before relying on WhatsApp scans. It keeps one linked-device
connection alive while the Mac is awake, durably queues messages from the configured groups, and
sends read receipts only after local persistence. A later `npm run jobs -- --days 2` consumes that
inbox and evaluates the linked pages without opening a second WhatsApp connection. Closing the web
dashboard does not stop the Collector.

The source-health panel shows the Collector ID, connection state, and received/queued totals. Every
Collector process has its own heartbeat and event timeline. Share a visible identifier such as
`Collector #12`, `Scan #41`, or `Action #9` for diagnosis on the same machine, or inspect it with:

```bash
npm run diagnostics -- collector 12
npm run diagnostics -- run 41
npm run diagnostics -- action 9
```

After a successful foreground test, macOS can start the Collector at login:

```bash
npm run whatsapp:collector:install
npm run whatsapp:collector:status
```

Use `npm run whatsapp:collector:uninstall` to remove only the LaunchAgent; the database and auth
session are preserved. Background mode suppresses QR output, so pairing is always performed with a
foreground `npm run whatsapp:collector`. See the
[Collector runbook](whatsapp-collector-runbook.md) and
[architecture decision](adr/0001-persistent-whatsapp-collector.md).

On first WhatsApp use, the terminal shows a QR code. Pair it from WhatsApp under **Linked
devices**. The local `auth/` directory contains sensitive session credentials and must never be
committed or shared. WhatsApp access uses the unofficial Baileys client, so upstream WhatsApp
changes can occasionally require a dependency update or a new pairing.

WhatsApp read state is separate from scan success. With `sources.whatsapp.markRead: true`, the
Collector sends read receipts **only after an incoming configured-group message is durably queued**.
The message may still be waiting for URL extraction or job-page evaluation, so a receipt is not an
"interesting job" decision. When no Collector is active, the legacy one-shot scan sends receipts
only after URL extraction succeeds. Empty scans never fall back to old stored IDs or mark the whole
chat read. Receipts are sent in batches of 100; one-shot scans also use a 10-second acknowledgement
timeout and retain the count acknowledged so far.
The UI reports sent, skipped, or failed independently of coverage. A successful API call is not
proof that the phone's unread counter cleared. No other chats are touched, the scanner uses
`markOnlineOnConnect: false`, and it never sends a chat message.

The separate, explicit `npm run jobs:mark-read` action still supports configured-chat state and
old stored-ID fallbacks, without running job scoring. Its output identifies these methods; they
must not be interpreted as evidence of messages received by the current scan.

If WhatsApp declines an on-demand history request, a browser-assisted or exported JSON array of
links can be imported with `jobs:import-whatsapp-links`. The importer accepts only configured group
names, canonicalizes and deduplicates URLs, stores no surrounding chat text, and is safe to rerun.
Imported links remain pending until `npm run jobs -- --whatsapp-backlog` fetches the destination
pages and evaluates them. One backlog run processes up to 500 stored messages per group.

Keep `authPath` inside this project so Baileys can safely refresh its session files. When moving
from the standalone `whatsappJobsScanner`, copy its existing private `auth/` directory into this
project once and set `authPath: "auth"`; the original session can remain untouched. Import its
message-level dedup state once with `npm run jobs:migrate-whatsapp`. The import is idempotent and
never moves a newer checkpoint backwards. After migration, avoid running both scanners at the
same time so two copies of the same linked-device session do not update independently.

Each run reports ATS counts and, for every configured WhatsApp group, the number of messages and
job links processed. Collector runs separately report live/history ingress, connection continuity,
and read receipts. Messages are accepted only
from the configured group JIDs. Their bounded text is kept in the local SQLite inbox only while the
message is pending or failed; after successful processing, the text is erased and only dedup
metadata remains.

The local dashboard includes a per-source and per-group audit funnel. WhatsApp coverage is marked
`complete`, `partial`, `unknown`, or `failed`; a run with unproven coverage is persisted as
`incomplete` rather than a successful empty scan. Safe structured audit events are stored in the
local SQLite database with the run ID, stage, status, counts, and bounded metadata. Credentials,
session material, and full message bodies are never copied into audit events.

After URL extraction, scoring uses only the fetched job page—not the WhatsApp message text. The
dashboard reports, for ATS and for each WhatsApp group, how many unique links were read, matched,
rejected, failed, or had already been processed. Rejected roles retain only technical identity and
evaluation hashes for deduplication; their description, decision details, source label, and cached
page text are removed.

“New” in the phone UI and “history” in the scanner are not opposites. A message that arrives while
JobOps is stopped is new to the user, but on the next scanner connection it is an offline gap that
WhatsApp must sync. JobOps uses a Desktop identity with `syncFullHistory: true`; it does not
guarantee that the server will deliver the offline gap.

### Local backlog and durable history requests

The scan page separates two operations that used to look identical. **Process local backlog** reads
messages already stored in `data/jobs.db`; it can process the last seven days or the next bounded
batch, newest first. Each action handles at most 100 messages per configured group. It extracts URLs
locally, evaluates the fetched job pages through the normal pipeline,
and erases each message body after successful URL extraction. These runs use the separate
`whatsapp-backlog` source key, so they cannot advance the successful live-scan window.

**Request history from the Collector** creates one durable 7-, 30-, or 90-day request. The active
Collector claims it and uses its existing WhatsApp socket—never a second connection with the same
credentials. The dashboard keeps per-group progress: request state, batches, delivered messages,
newly queued messages, duplicates, and a bounded failure reason. If the owner process dies, the next
Collector returns the request to the queue. A request is counted only when its delivered history
event matches the session identifier returned by Baileys.

### Empty connections and bounded history recovery

After connection warm-up, each configured group can wait up to 60 additional seconds for a recent
real message. Groups wait concurrently. Recovery uses the newest genuine message from the current
buffer, current-chat metadata, or the local `whatsapp_anchors` table. That table stores only one
validated message key and timestamp per configured group, not message text. Legacy dedup IDs are
not converted into cursors because they lack the original full key.

The [Baileys history API](https://github.com/WhiskeySockets/Baileys/blob/master/README.md) paginates
**backwards** from a real message. A saved old cursor cannot request messages newer than itself.
Each group has a three-minute recovery budget, at most 20 requests of 50 messages, and bounded
12-second request/response waits. Mixed old and new buffer entries alone do not prove coverage;
pagination tracks actual history deliveries, including repeated IDs, separately from live upserts.
On-demand pages are correlated with `peerDataRequestSessionId`, so an unrelated initial history
event cannot be counted as the response to the active request.

Coverage is complete only when pagination reaches the start of the requested window and the
anchor reaches its end. Quiet groups can therefore remain conservatively partial even if their
available messages were processed. The dashboard reports a specific cause such as `missing_anchor`,
`anchor_too_old`, `history_no_response`, `history_request_timeout`, or `newer_messages_unverified`,
alongside recovery requests, delivered messages, and job outcomes. Zero delivery is not a clean
empty inbox. If recovery still fails, keep the phone online, check Linked devices, and try again
after a new message arrives in that group. Re-pairing is a possible later troubleshooting step,
not an automatic action or a guaranteed fix. The scanner never resets credentials automatically.
The Baileys 6 line is pinned to `6.7.24` so a reinstall cannot silently change linked-device
behavior.

## Codex scoring without API billing

New active jobs are scored through `codex exec`, authenticated with the local ChatGPT login.
The child process is forced to the `chatgpt` login method, ignores API-oriented user config,
does not inherit `OPENAI_API_KEY`, and runs in a read-only ephemeral sandbox. Jobs are grouped
in batches of eight by default to reduce repeated context.

This avoids usage-based OpenAI or Anthropic API billing. It still consumes the included
Codex/ChatGPT usage allowance or workspace credits associated with the signed-in plan. See the
[official Codex authentication documentation](https://learn.chatgpt.com/docs/auth) and
[non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Repeat protection and scan windows

`data/jobs.db` is the source of truth for job URLs, normalized company/role identities, the company
watchlist and source health, message status, page cache, scan checkpoints, and whether a result was
already shown or opened.
The dashboard also lets you archive a reviewed match. Archived jobs disappear from active lists,
retain only their dedup identity, and cannot surface again in later scans.

The unified ATS adapter deliberately ignores the older Markdown/TSV dedup files while collecting;
every candidate first reaches SQLite, which prevents a legacy pipeline entry from disappearing
before it can be evaluated for the dashboard. The older standalone scan commands keep their
original file-based dedup behavior.

ATS discovery counts distinguish unique candidates **found**, **new to this SQLite database**, and
**already known**. A duplicate within the same run is counted once and retains its first-seen
classification. "New" is not a fit decision: the processing funnel separately shows page/scoring
success, matches, rejections, failures, and previously processed jobs. Known archived or rejected
roles do not reappear as new matches.

- The first run looks back two days by default.
- Later runs start from the last successful run with a 12-hour overlap.
- `--days N` explicitly selects a window, capped by `maxLookbackDays`.
- Tracking parameters are removed before URL comparison.
- Failed WhatsApp messages remain retryable; successful messages are not processed again.
- A page is rescored only when its content, status, profile, or scoring criteria change.

These values are configurable in `config/jobs.yml`.

## Project structure

```text
config/jobs.example.yml  public configuration template
portals.yml              ATS/official career sources and fast pre-filters
scripts/jobs.mjs         unified CLI
scripts/jobs/            shared collection, scoring, storage, and reporting modules
scripts/jobs/company-*   company catalogue bootstrap and persistent registry rules
scripts/jobs/company-source-resolver.mjs  researched URL discovery, safe probing, and source selection
scripts/providers/       ATS and official career-source adapters
scripts/web.mjs          local dashboard entry point and API composition
scripts/dashboard/       dashboard actions, focused queries, and safe static routing
web/*.html               scan, decision, and company pages
web/shared/              shared browser API, navigation, formatting, and polling modules
web/pages/               one controller module per dashboard page
tests/                   Node test suite
templates/               public profile and document templates
docs/assets/             public screenshots generated from demo data
docs/company-expansion-research.md  seed-to-peer map and career-source verification
docs/adr/0004-company-source-resolution.md  source-discovery architecture and trade-offs
docs/adr/0005-platform-adapters.md  reusable hiring-platform adapter contract
.agents/skills/          reusable Codex job-search workflows

profile/                 private candidate profile (ignored)
auth/                    private WhatsApp session (ignored)
data/                    private SQLite state and application pipeline (ignored)
reports/                 generated reports (ignored)
documents/               the single current source CV (ignored)
```

The older focused commands remain available for maintenance tasks:

```bash
npm run scan:dry
npm run liveness
npm run dedup
npm run normalize
npm run pdf -- input.html /tmp/jobops-cv.pdf --format=a4
```

## Development

```bash
npm run check
npm test
npm run scan:dry
```

## Engineering decisions

- **One source of truth:** SQLite owns URL identity, source checkpoints, page cache, decisions,
  presentation, opening, archive state, and user-approved company tracking.
- **Explicit discovery approval:** WhatsApp and manual discovery can create a candidate but never
  enable scanning. Only the dedicated approval endpoint changes it to `watched`.
- **Explainable but quiet:** the primary decision remains `מתאים` or `לא מתאים`; detailed scoring
  is available on demand without adding report columns.
- **Privacy by construction:** rejected roles discard descriptive data and retain only the
  technical identity required for deduplication.
- **Bounded local actions:** the dashboard executes a fixed allowlist of commands without a shell
  and listens only on `127.0.0.1`.
- **No scoring API key:** matching runs through the locally signed-in Codex CLI and explicitly
  removes API-oriented credentials from the child process.
- **Runnable without secrets:** `npm run demo` makes the full product surface reviewable with
  isolated synthetic data.

CI runs syntax checks and the test suite on Node.js 22. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for contribution and privacy guidance.

## Privacy and publication

The repository is designed so the reusable application can be published while candidate data,
CVs, WhatsApp credentials, scan state, generated reports, and environment variables stay local.
Before publishing, review `git status --ignored` and run `gitleaks dir . --redact`.

During scoring, the candidate profile and fetched job text are sent to Codex under the data and
retention settings of the ChatGPT account or workspace used by `codex login`.

jobOps is available under the [MIT License](../LICENSE). Adapted upstream components and their
original MIT notice are documented in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Roadmap

1. Validate the persistent Collector across several days and review Collector IDs after every gap.
2. Migrate Baileys 6.x and the multi-file auth state to Baileys 7 plus a transactional auth store
   as a separately tested compatibility change.
3. Add a DueTo adapter if its public job-board contract proves stable, starting with FINQ and keeping
   the same source-health reporting, input bounds, and deduplication rules as the Comeet adapter.
4. Add sector/company discovery adapters (portfolio boards and curated exports) that feed the same
   candidate-and-approval flow; never auto-enable discoveries.
5. Add more ATS providers only when they unlock meaningful target companies.
