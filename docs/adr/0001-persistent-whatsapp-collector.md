# ADR 0001: Persistent WhatsApp Collector

- Status: Accepted
- Date: 2026-09-08

## Context

The previous WhatsApp source connected only while a job scan was running. Messages that arrived
while JobOps was stopped depended on a later Baileys history-sync event. WhatsApp does not
guarantee that every offline gap will be replayed to a linked device, so an empty connection could
not prove that a busy group contained no new messages. Repeated short-lived connections also made
session failures difficult to correlate and increased the chance of concurrent use of the same
Signal auth state.

## Decision

JobOps separates WhatsApp ingestion from job processing:

1. One long-lived Collector owns the WhatsApp connection while the Mac is awake.
2. Incoming messages from the configured groups are durably inserted into SQLite.
3. Read receipts are sent only after the message has been accepted by the local inbox.
4. A job scan consumes the inbox, extracts URLs, fetches the linked job pages, and evaluates those
   pages. The WhatsApp message text is not used to decide fit and is erased after URL extraction.
5. A process lock prevents two Collectors from using the same local session.
6. Collector runs, heartbeats, counters, connection transitions, group verification, reconnects,
   and classified failures are recorded separately from job scans.

The first implementation keeps the repository's pinned Baileys 6.x session format. A Baileys 7
upgrade and transactional auth-key store will be a separate migration so protocol changes are not
mixed with the ingestion architecture change.

## Options considered

### Reconnect only during each scan

This is simple but cannot prove delivery across offline gaps and repeats expensive session setup.
It remains a fallback when no Collector has ever been started.

### Browser automation against WhatsApp Web

This could reuse a visible browser session, but DOM selectors and anti-automation behavior are
fragile, message extraction is harder to test, and read-state changes are less deterministic.

### Official WhatsApp Cloud API

The Cloud API is designed for business messaging and does not provide a supported way to read the
existing private groups of a personal WhatsApp account. It does not satisfy this project's source
requirements.

### Persistent Baileys linked device

This matches the existing local-first workflow and receives live events while connected. It is an
unofficial client, so upstream compatibility remains an operational risk and is surfaced explicitly.

## Consequences

- The Collector should start at login and remain active while the Mac is awake.
- The dashboard can distinguish “connected and observing” from “a scan returned zero”.
- A scan can claim full Collector coverage only when the current connection began before the
  requested window. A reconnect or heartbeat pause (including Mac sleep) inside the window resets
  the continuity timestamp and is conservatively reported as `collector_gap`.
- Closing the browser UI does not stop the Collector; sleeping or shutting down the Mac does.
- Session credentials remain sensitive local files under `auth/` and are never copied to diagnostics.
- The SQLite inbox temporarily contains bounded message text until URL extraction succeeds.

## Follow-up

- Validate the Collector for several days with the current Baileys version.
- Plan and test a Baileys 7 migration separately.
- Replace the multi-file auth store with a transactional SQLite-backed store during that migration.
- Add bounded retention for old diagnostic events if the database grows materially.
