---
title: Fresh Recents — implementation plan
status: implemented — independent review passed; full check passed
created: 2026-09-05
reviewed: 2026-09-05
---

# Fresh Recents implementation plan

## Outcome

After any supported Recents mutation commits, every connected Recents page receives the newest queue without user action. A resumed page refreshes before trusting its old view, and a late response can never overwrite newer state.

Keep the current vanilla page and host placement behavior. Freshness belongs to the daemon and browser HTTP contract, not Wave or cmux adapters.

Implemented 2026-09-05. The complete check passes: 159 tests, TypeScript, and the production web bundle.

## 1. Put Recents state transitions behind one daemon service

Add `RecentsService` in `src/recents/service.ts`. It owns the existing `RecentsRegistry`, host synchronization, a serialized operation queue, a daemon-local snapshot sequence, and snapshot subscribers.

```ts
type RecentsSnapshot = {
  sequence: number;
  files: Array<RecentEntry & { name: string; directory: string }>;
};

interface RecentsService {
  snapshot(): Promise<RecentsSnapshot>;
  files(): Promise<RecentsSnapshot["files"]>;
  paths(): Promise<string[]>;
  record(path: string, target?: HostTarget): Promise<RecordRecentResult>;
  recordMany(paths: string[], target?: HostTarget): Promise<RecordRecentsResult>;
  remove(path: string, target?: HostTarget): Promise<SyncRecentsResult>;
  subscribe(listener: (snapshot: RecentsSnapshot) => void): () => void;
}
```

Keep the registry private to this service. Route `/api/files`, `/api/open` and `/api/action` authorization reads through `files()` or `paths()` on the same queue; no production route retains a raw registry reference. Serialize snapshots, authorization reads, and mutations together. Assign `sequence` only after the registry read that produced a snapshot. This makes response order explicit even when an earlier request completes later. The sequence is scoped to one daemon instance; durable revision storage is unnecessary because restored pages already require a new daemon-scoped session.

Make the queue failure-tolerant. Each operation waits for the previous tail with rejection swallowed, and releases its own tail in `finally`; only the current caller receives the current operation's error. A host-sync rejection after commit must not poison later snapshots or mutations.

For a mutation, in one queued operation:

1. commit the registry write;
2. read and sequence the resulting live-file snapshot;
3. publish the snapshot to subscribers, isolating dead-listener failures;
4. await host synchronization;
5. return the existing result shape.

Publish before host synchronization. If Wave launcher synchronization fails, preserve current behavior: the initiating request fails, but the already-committed registry update remains present. Connected Recents pages must receive that committed state.

Keep `DaemonOptions.recents?: RecentsRegistry` for existing injection points and wrap it with the service inside `createDaemon`. Export the service and snapshot types through `src/recents/index.ts`.

Make host synchronization report whether work actually occurred. Allow `recentsChanged` to return `boolean | void`; `HostGateway` returns `true` only after a Wave bridge update and `false` for cmux/browser targets. Existing adapters and test doubles returning `void` continue to count as synchronized when the method exists. This preserves accurate `hostSynchronized` CLI output.

## 2. Eliminate the production out-of-process writer

Add authenticated `POST /control/recents/add`, accepting `{ path, target? }`, and a matching `controlRecentsAdd()` lifecycle client. It calls the daemon's `RecentsService.record()` and returns the canonical path, count, and host-sync result.

Change `mdreview recents add` to use that endpoint instead of constructing `RecentsRegistry` in the CLI process. Preserve its arguments, one-object stdout contract, exit codes, response fields, and host detection.

For a production Wave invocation, ensure the daemon first, then attempt to start/reuse the credential-bearing Wave bridge before issuing the control mutation. Do not return early if bridge preparation fails: still issue the mutation so it commits and publishes before daemon-side Wave synchronization reports failure. If a healthy bridge is already available, the mutation may still succeed. Injected-host tests should run the daemon with that host adapter and must not start a real bridge. cmux and browser need no new bridge work.

Handle this control route separately from the document/review `controlError()` mapping. An operational registry or host-sync failure returns structured code `command_failed`; `controlRequest()` must preserve it so `recents add` retains its current exit status and protocol error shape. A Wave synchronization failure still occurs after registry commit and publication. Failure tests must assert both the exact CLI error code and the committed queue/SSE state.

Direct registry reads used by `recent <index>` and `wave install` may remain: they do not bypass mutation publication or create cross-process write races. No production code may call `add`, `addMany`, `remove`, or `clear` outside the daemon service after this change.

## 3. Add revisioned snapshot and SSE routes

Keep `GET /r/:session/api/files` returning its current array for compatibility. Add:

- `GET /r/:session/api/snapshot` → `{ sequence, files }`;
- `GET /r/:session/api/events` → `text/event-stream` snapshots with SSE `id` equal to `sequence`.

Both routes use the existing Recents session and path-scoped HttpOnly cookie. No control credential, host credential, document grant, or path authority enters the stream.

For each event stream:

1. register the subscriber before requesting its initial snapshot;
2. send the initial snapshot through that subscriber;
3. send periodic SSE comment frames to keep idle connections alive;
4. use one idempotent cleanup function that unsubscribes and clears the heartbeat.

Call cleanup from `ReadableStream.cancel()`, request abort, initial-snapshot failure, controller enqueue failure, and daemon stop. Track live stream closers separately from Recents sessions; `stop()` closes their controllers before awaiting `bunServer.stop()`.

No replay buffer is needed. On connection or reconnection, send the current complete snapshot; freshness requires current state, not delivery of every intermediate queue ordering. Include `Cache-Control: no-store`, `Content-Type: text/event-stream`, UTF-8 encoding, and no fixed content length.

On daemon stop, close every stream and clear subscriber resources before awaiting `bunServer.stop()`. SSE connections remain presence signals only and must not change Recents-session authorization or the existing explicit-stop/idle policy.

## 4. Make the page monotonic and suspension-safe

In the existing inline Recents script:

- track `lastSequence`, initially `-1`;
- fetch `/api/snapshot` at startup so the page still loads if SSE setup fails;
- open `new EventSource('./api/events')` and apply each valid snapshot only when `sequence > lastSequence`;
- refresh `/api/snapshot` on `visibilitychange` to visible and on `pageshow`;
- on SSE error, leave automatic reconnection enabled and request one debounced snapshot refresh;
- retain current explicit refreshes after picker/remove/trash as harmless recovery paths.

Treat freshness as an interaction gate, not only a background fetch. Start unverified. On `pagehide` or transition to hidden, mark the current snapshot stale. On initial load, `pageshow`, or transition back to visible:

1. record the current `lastSequence` as the revalidation floor;
2. keep the rendered data but mark it unverified and disable every queue action;
3. request a snapshot;
4. restore actions only after applying a valid snapshot or SSE event whose sequence is greater than that floor.

If revalidation fails, retain the rows for context but show an explicit retrying/unverified state and keep them non-actionable. Automatic SSE reconnect or a later visibility refresh can satisfy the gate. Validate that every received sequence is a non-negative safe integer.

Applying a remote snapshot must preserve the filter and ordinary status text. Reconcile transient controls:

- remove selected paths no longer present;
- close the context menu if its target disappeared;
- close an open batch confirmation if its selected set changed, requiring confirmation against the new state;
- do not cancel an in-flight local action or clear its busy state.

Malformed events are ignored; a later valid event or visibility refresh heals the view. A failed snapshot request must not erase the last valid list. Keep the existing “Session expired” handling for an authenticated snapshot response that fails.

## 5. Verification

Add focused unit and HTTP tests before adjusting existing expectations.

### Recents service

- concurrent mutations serialize and publish strictly increasing snapshots;
- a snapshot queued before a mutation has a lower sequence even if consumed later;
- a host-sync failure rejects the caller after publishing committed state;
- after that host-sync failure, a later mutation and snapshot still succeed with higher sequences;
- one broken subscriber neither blocks other subscribers nor fails a mutation;
- unsubscribe prevents later delivery.

### Server and browser page

- snapshot and SSE routes reject missing/wrong Recents cookies;
- a stream immediately receives current state and two simultaneous sessions receive later launch, picker, remove, trash, and control-add changes;
- reconnect receives the current snapshot without replaying history;
- request abort, response-body cancellation, initial-snapshot failure, enqueue failure, and daemon stop remove subscribers; shutdown completes;
- a late older startup/visibility response cannot replace a newer SSE state;
- initial and resumed pages cannot act on stale rows while revalidation is pending, and a newer SSE snapshot can satisfy the gate;
- filtering, selection, confirmation, context-menu, busy, and timed-status behavior remain correct under remote updates;
- JSDOM tests use a small fake `EventSource`; no browser dependency is added.

### CLI and hosts

- `recents add` reuses one daemon and no longer writes the registry directly;
- concurrent CLI adds retain both paths and notify an open Recents stream;
- CLI response shape, `command_failed` error code, exit status, and post-failure committed-state behavior remain unchanged;
- Wave bridge startup precedes the control mutation when required;
- cmux Recents reuse, focus, Dock placement, and document-opening behavior are unchanged;
- no adapter gains a page-refresh responsibility.

Run the complete required check, inspect the final diff, and manually validate one retained cmux Dock Recents surface while `mdreview open` and `mdreview recents add` reorder the queue:

```sh
mkdir -p "$TMPDIR/bun-tmp"
TMPDIR="$TMPDIR/bun-tmp" bun run check
```

## Acceptance boundary

The work is complete when all supported mutation paths publish through one service; every connected page converges automatically; resumed pages revalidate; stale asynchronous responses cannot regress the display; existing authorization, host placement, launcher synchronization, UI interaction, CLI protocol, and daemon shutdown semantics remain intact.
