# WhatsApp Collector Runbook

## Purpose

The Collector keeps one linked-device connection open, writes configured-group messages to the
local SQLite inbox, and records enough evidence to diagnose every connection period. The web UI and
job scans are separate processes and may be opened or closed without stopping ingestion.

## First pairing and foreground validation

Run the Collector in a terminal first:

```bash
npm run whatsapp:collector
```

If the latest record says `pairing_required`, scan the terminal QR from WhatsApp → Linked devices.
Keep this terminal open for the first validation. The dashboard should show `connected`, the four
configured groups, a fresh heartbeat, and increasing received/queued counters when messages arrive.

Stop it cleanly with `Ctrl+C`. The run should end as `stopped`.

## Start automatically at macOS login

After the foreground validation succeeds:

```bash
npm run whatsapp:collector:install
npm run whatsapp:collector:status
```

The LaunchAgent starts the Collector at login and restarts it after ordinary process failures. It
does not run while the Mac is shut down or asleep. QR values are hidden in background mode; if
pairing is required, stop the service and pair from a foreground terminal.

```bash
npm run whatsapp:collector:uninstall
npm run whatsapp:collector
```

Reinstall after pairing if background startup is desired. Uninstalling preserves `data/jobs.db`
and `auth/`.

## Diagnose a run

The dashboard's “What failed and why?” selector includes scans, actions, and Collector runs. Copy
the visible identifier, for example `Collector #12`, and share only that identifier when asking for
help on the same machine.

The same safe record is available from the terminal:

```bash
npm run diagnostics -- collector 12
npm run diagnostics -- run 41
npm run diagnostics -- action 9
npm run diagnostics -- --latest
```

Useful evidence includes:

- last stage and heartbeat;
- connected and last-message timestamps;
- received, queued, duplicate, rejected, and read-receipt counters;
- configured-group verification counts;
- reconnect attempts and classified terminal failures;
- a bounded event timeline without message bodies, QR data, auth files, or raw exception output.

## Recover and process historical messages

Use the **WhatsApp sync** card on the scan page for two operations:

1. **Process collected messages** reads the last seven days already stored in `data/jobs.db`. It
   extracts links and evaluates the linked job pages; it does not use the WhatsApp message text as
   the job description and does not open a second WhatsApp connection.
2. **Fill history gaps** captures a separate starting cursor for every configured group. The cursor
   is the last message collected for that group, with a one-second overlap for safe deduplication.
   The request is durable: when the Collector is offline it waits, and the Collector attempts it
   after reconnecting.

The request progresses from `pending` to `running`, then `complete`, `partial`, or `failed`.
Per-group results show the captured cursor, delivery outcome, newly queued count, and failure reason.
`history_no_response` means WhatsApp accepted the linked-device request but did not deliver a
matching history event; zero is not treated as a clean empty group. This recovery path depends on
WhatsApp's linked-device history delivery and cannot retrieve data while the socket is disconnected.
After history is queued, run **Process collected messages** to evaluate the actual linked job pages.

The Collector uses `Browsers.ubuntu('Chrome')` with `syncFullHistory: true`. Existing credentials are
never deleted automatically. If repeated requests fail, stop the background service and validate a
controlled foreground pairing only after backing up `auth/`.

The group table is the operational view: last collected timestamp, latest-run delivery and link
counts, suitable and failed evaluations, and the current local queue. Pending/failed message bodies
older than seven days are erased automatically. Their message ID, group, timestamp, and terminal
state remain in SQLite solely for deduplication and receipt tracking.

## Common states

- `connected`: live messages should reach SQLite.
- `collector_gap`: a scan processed stored messages, but the Collector was not connected for the
  entire requested window. A reconnect or long heartbeat pause such as Mac sleep creates this gap.
  This is not evidence that the remaining interval was empty.
- `pairing_required`: run the Collector in a terminal and scan a new QR.
- `connection_replaced`: another process used the same linked-device session. Stop old scanners and
  keep only one Collector.
- `decrypt_failed`: session keys could not decrypt an incoming event. Repeated occurrences may
  require a controlled re-pair; never delete `auth/` automatically.
- `interrupted`: the recorded process disappeared without a terminal event, for example after power
  loss or `SIGKILL`.
- `unconfirmed`: the heartbeat is stale but the process state does not prove it exited.

## Data and privacy

The Collector accepts only configured group JIDs. Message text is bounded, stored only while pending
or failed, and erased after URL extraction. Diagnostics store counts, safe configured group names,
and allowlisted failure explanations. They do not store credentials, QR codes, message bodies, full
URLs, or arbitrary stack traces.
