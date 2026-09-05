# Fresh Recents queue

**Recommendation:** centralize every production mutation in the daemon, then publish revisioned Recents snapshots over server-sent events (SSE). Refresh once when a page becomes visible again. Do not add React or make host adapters responsible for freshness.

This gives all browser environments the same behavior, updates every open Recents view after a committed mutation, survives dropped connections and suspended webviews, and preserves UI state instead of reloading the page.

## 1. SSE from a daemon-owned Recents coordinator

Make the daemon the sole production writer. A small coordinator should own:

- the existing `RecentsRegistry`;
- a monotonically increasing in-memory revision;
- serialized `snapshot`, `add`, and `remove` operations;
- subscribers for `{ revision, files }` snapshots.

Add a cookie-authenticated `GET /r/:session/api/events` SSE endpoint. Register the subscriber before obtaining its initial snapshot, and let the client apply only snapshots newer than its current revision. That ordering prevents an older initial read or overlapping fetch from overwriting a newer pushed state. SSE is a native one-way fit, automatically reconnects, and supports event IDs; periodic comment frames can keep an idle stream alive. [MDN documents the transport and reconnect behavior](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

Also refresh the revisioned snapshot on `visibilitychange` to visible and `pageshow`. Embedded webviews may suspend network delivery; visibility refresh is the cheap correctness backstop. Browsers can throttle background timers, which is another reason not to rely on polling alone. [The Page Visibility API is broadly available](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).

Keep the current vanilla DOM renderer. React would change view composition, not how state reaches the page.

### Required centralization

Current mutations are split across processes:

- document launch exchange records through the daemon (`src/server/server.ts:393`);
- picker, remove, and trash actions mutate through the daemon (`src/server/server.ts:448`, `src/server/server.ts:484`);
- `mdreview recents add` constructs and writes a registry directly in the CLI process (`src/cli/main.ts:147`).

The registry queue is process-local (`src/recents/registry.ts:19`), so the CLI can race a daemon write as well as bypass daemon notifications. Route `recents add` through a control endpoint. Keep `RecentsRegistry` as storage, but expose production writes only through the coordinator.

Publish immediately after the registry commit and before host synchronization. Today a Wave launcher update can fail after the JSON mutation has already committed (`src/recents/service.ts:32`). The Recents page must still show the committed truth; host-launcher synchronization is a separate outcome.

### Minimum implementation slice

1. Add `RecentsCoordinator.snapshot/add/addMany/remove/subscribe` and use it in every daemon route.
2. Add a daemon control route for `recents add`; have the CLI use it and pass its host target.
3. Return `{ revision, files }` from the snapshot endpoint and stream the same shape over SSE.
4. In the existing page script, apply snapshots monotonically; reconnect through `EventSource`; refresh on visible/pageshow.
5. Test two simultaneous Recents sessions, CLI and launch mutations, reconnect/current-state delivery, a slow stale fetch arriving after a newer event, host-sync failure, and subscriber cleanup.

The daemon currently runs plain loopback HTTP. SSE over HTTP/1.1 commonly has a per-origin connection limit; this is acceptable for the intended one retained Recents view per host, but should be documented and tested if Tether later encourages many simultaneous Recents tabs. [MDN notes the usual six-connection browser limit without HTTP/2](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#listening_for_custom_events).

## Ranked alternatives

### 2. Revision-aware long polling

Hold `GET /api/changes?after=<revision>` until the revision advances or a timeout expires, then return a snapshot. This has nearly the same semantics and avoids SSE connection-limit concerns, but requires custom retry, timeout, cancellation, and shutdown handling that `EventSource` already supplies. Choose it only if Bun or an embedded host proves unreliable with streaming responses.

### 3. Conditional polling while visible

Poll a cheap revision or ETag while visible, fetch files only when it changes, and refresh immediately on visibility restoration. This is the smallest stopgap and likely sufficient at a 1–2 second interval, but it deliberately permits a stale interval and background throttling makes its upper bound unreliable. It does not satisfy the stated guarantee.

### 4. Force host browser reload after mutation

cmux exposes targeted browser reload, so its adapter could rediscover and refresh the retained Dock surface. [cmux documents `browser <surface> reload`](https://cmux.com/docs/browser-automation#navigation). This is still the wrong primary boundary: it is host-specific, cannot reach arbitrary system-browser tabs, may not reach every Wave view, requires surface discovery, and destroys filter, selection, menu, and in-flight interaction state. Keep it only for stale-session recovery.

### 5. WebSockets

They solve the problem but add a bidirectional protocol, heartbeat, reconnect, and framing machinery when Tether needs one-way notifications. They become reasonable only if later product behavior requires sustained browser-to-daemon streaming.

### 6. React

Not a freshness mechanism. It adds a runtime dependency and migration cost while leaving the same need for polling, SSE, or sockets. Consider a component framework later only if Recents UI complexity itself becomes costly.

## Patterns not worth adopting now

- `BroadcastChannel` can synchronize same-origin pages but cannot observe CLI writes; at most it is a later connection-sharing optimization.
- Watching `recent-files.json` would detect out-of-process writes, but filesystem-watch behavior around atomic rename is platform-sensitive. Removing out-of-process writers is simpler and also fixes write races.
- Host-native events or scripted DOM injection bind correctness to Wave/cmux capabilities. Neither belongs in the host-neutral core.

## Freshness contract

“Never stale” cannot mean zero physical propagation time. The enforceable contract is: after a registry mutation commits, every connected Recents view receives the new revision without user action; a view returning from suspension obtains the current snapshot before relying on its prior state; and older asynchronous responses can never replace newer state.
<!-- wave-annotations:v1
{"type":"ledger","documentId":"f3a5004e-0c46-4c76-9e58-4e567373a217","baseBodyRevision":"sha256:8db8399b9c4b8be6cea1a8a253a730bea084c83efd904aa78f08bd15bc8d808d","createdAt":"2026-09-05T19:09:39.374Z"}
{"type":"comment","id":"a-180a2186-8708-4a3b-ac7a-bc33ee540c2d","seq":1,"actor":"hart","createdAt":"2026-09-05T19:09:39.374Z","anchor":{"exact":"The Recents page must still show the committed truth; host-launcher synchronization is a separate outcome.","prefix":"SON mutation has already committed (src/recents/service.ts:32). ","suffix":"\nMinimum implementation slice\nAdd RecentsCoordinator.snapshot/ad","projectionStart":2561,"projectionEnd":2667,"bodyRevision":"sha256:8db8399b9c4b8be6cea1a8a253a730bea084c83efd904aa78f08bd15bc8d808d"},"body":"what? this is really abstract, please make it really concrete and say what this second clause means. be succinct."}
{"type":"delete","id":"a-7b26585a-9abe-42c1-9045-5fde21c93188","seq":2,"actor":"hart","createdAt":"2026-09-05T19:13:12.461Z","targetId":"a-180a2186-8708-4a3b-ac7a-bc33ee540c2d","threadId":"a-180a2186-8708-4a3b-ac7a-bc33ee540c2d"}
-->