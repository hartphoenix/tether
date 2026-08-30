# Phase 2 — standalone daemon and browser vertical slice

## Objective

From a Tether source checkout, `mdreview open file.md` starts or safely reuses one local daemon, grants a browser session access to that one canonical Markdown file, records it in Tether Recents, and opens the extracted editor in the system browser. Wave must not be installed or running.

This phase is an extraction and boundary-setting pass, not a redesign of the working editor.

## Source baseline

Use the Roger repository's committed Wave fallback at commit `348563b` as the extraction source. Relevant implementation lives under `scripts/wave-markdown/`:

* `server.ts` and `server.test.ts` — document/review transactions, atomic writes, real-path queue, leases, lifecycle, API and CLI behavior;
* `index.html`, `app.ts`, `style.css`, `themes.css`, `themes.ts` — editor shell and themes;
* `annotations-ui.*` — thread drawer, inline/popover presentation, open/resolved filtering, orphan handling;
* `selection-ui.*`, `editor-commands.*`, `incoming-diff.ts` — selection tools and editing integration;
* `chrome-controls.ts`, `chrome.css` — toolbar controls and overflow behavior;
* `markdown-codec.ts` and `annotation-ledger.ts` — already extracted into Tether core.

Copy behavior and tests from that baseline; do not import Roger at runtime. Keep the current Wave installation unchanged as the daily-use fallback.

## Behavioral parity to preserve

The browser build must retain the current working editor behavior:

* Milkdown/Crepe rendering and editing, current formatting toolbars, sticky toolbar, responsive ellipsis overflow, theme picker, zoom popover, copy and save controls;
* app-wide persistence of the last selected theme. Because Tether uses an OS-assigned port, do not rely on origin-bound `localStorage` for this: persist the preference through the daemon's profile config. Zoom may remain session-local unless carrying its current behavior is cheaper;
* comments and replies displayed as threads; only `open` and `resolved` states; resolved hidden by default behind “Show resolved”; `orphaned` is an independent location condition; orphaned threads remain replyable;
* agent replies receive the existing restrained attention treatment rather than a screen-wide color change;
* malformed ledgers open read-only with the body preserved; body edits preserve ledger bytes; annotation appends preserve existing body and ledger bytes;
* tables wrap rather than overflow and native spellchecking remains disabled;
* file picker remains absent;
* wikilinks open a new Tether view and never navigate the source view.

Wave-only hidden navigation, widgets, destinations and file-navigator behavior belong to Phase 3. Mermaid rendering was not established as working behavior in the prototype and is not a Phase 2 blocker.

## Runtime and discovery

* Bind only to `127.0.0.1` with `port: 0`.
* Run one daemon per OS user and profile. Support safe `TETHER_PROFILE`, `TETHER_RUNTIME_DIR`, and `TETHER_CONFIG_DIR` overrides; use a distinct `preview` profile for transition testing.
* Store discovery plus an exclusive startup lock in a user-private runtime directory. Store Recents and app preferences in the profile config directory. Use `0700` directories and user-only files where supported.
* Discovery contains only `protocol`, `instanceId`, `pid`, `origin`, and `startedAt`. `/health` returns matching non-secret identity.
* Under the startup lock, validate PID, health service, protocol and instance ID. Remove stale records and locks. Concurrent launchers must reuse the winner.
* The CLI control credential must not be in discovery, browser URLs, logs, or browser code. A separate user-only control file is acceptable for this phase.

## Launch and document authorization

* `mdreview open` resolves an existing `.md` or `.markdown` file to its real path. That explicit action grants only that file.
* Mint a random, single-use, short-lived ticket. Exchange it for a distinct session route and `HttpOnly`, `SameSite=Strict`, path-scoped cookie, then redirect to a URL without the ticket.
* A browser session grants one document. Browser endpoints infer the file from the session and never accept an arbitrary client path.
* Recents records successful opens but grants nothing. Prove this in a test.
* Every view gets its own session, including repeated views of one file. Mutations still serialize through one queue keyed by canonical real path.
* Wikilinks resolve relative to the current document, validate the target, add it to Recents, mint a new session and call the host adapter. The original page remains unchanged.
* Do not enable permissive CORS. Validate same-origin state-changing browser requests.

## Documents, review API and storage

Extract these behaviors behind document and review services:

* read and exact export;
* body save with expected body revision;
* comment append with body/anchor revision validation;
* pending and individual-thread reads;
* reply, resolve, reopen, edit, delete and acknowledge;
* atomic replacement preserving source permissions;
* separate body and ledger revisions;
* malformed-ledger read-only recovery;
* complete read–validate–write transactions serialized by real path.

Retain `wave-annotations:v1` unchanged through the cutover rollback window. The embedded ledger remains the durable source of truth; do not add a sidecar database or JSON file.

Implement Recents as a small atomically written JSON registry of canonical paths with deduplication, most-recent-first ordering and stale-entry tolerance. Do not add SQLite.

Store only app preferences in profile config. No analytics or production telemetry is wanted; focused development logs are acceptable if they contain no document content or credentials.

## Host and CLI boundary

Define the narrow host adapter and capability response described in the product plan. Implement only the system-browser adapter, using an injectable platform URL opener so tests do not launch windows.

Provide a source-checkout `mdreview` executable with:

```text
mdreview open <file>
mdreview daemon status
mdreview daemon stop
```

Ordinary stdout is exactly one protocol-versioned JSON object. Diagnostics use stderr. Failures use structured JSON and documented nonzero exit codes. Defer the polished review command suite, MCP and skills to Phase 5 unless direct reuse is trivial.

## Lifecycle

Carry forward leases, explicit release, lease expiry, startup grace and idle shutdown. Closing all views must eventually stop the daemon. The daemon's main function must await the server's closed promise so shutdown exits the Bun process rather than leaving a CPU-spinning orphan.

Add a process-level regression test that launches a real child daemon, closes or stops it, and proves the child exits. Also test stale discovery recovery and simultaneous launcher convergence.

## Work division

Keep module ownership separate so parallel work integrates cleanly:

1. documents/review/Recents: filesystem gateway, grants, real-path queue, conflict rules, atomic JSON registry and integration tests;
2. daemon/discovery/auth/CLI/host: lock and discovery protocol, launch tickets, scoped sessions, lifecycle, browser adapter and process tests;
3. web extraction/integration: current UI copied from Roger and changed only where needed for session bootstrap, host-neutral link opening and daemon-backed theme preference.

The orchestrating agent owns contracts first, resolves overlaps, integrates all branches in the shared worktree, audits actual diffs, and runs the complete suite. Builders should not commit or push unless the orchestrator explicitly asks.

## Verification

Required automated coverage:

* document grant and denial of arbitrary paths;
* ticket expiry, single use, redirect and cookie path scoping;
* Recents does not authorize document access;
* body and ledger conflicts plus malformed-ledger recovery;
* concurrent same-file mutations preserve every event;
* distinct sessions for repeated views of one document;
* daemon reuse and simultaneous startup convergence;
* stale discovery recovery;
* explicit and idle shutdown leave no child process;
* CLI stdout/error schema;
* production web bundle.

Use unit, HTTP integration and process-level tests. Playwright and browser automation are explicitly out of scope. Do not weaken security behavior merely to simplify tests; inject clocks, openers, paths and command runners instead.

## Deferred

Do not install or edit Wave configuration, implement cmux, rename the annotation sentinel, add SQLite, create MCP or skills, build telemetry, implement automatic orphan re-anchoring, or attempt simultaneous legacy/Tether writes to the same real file.

## Exit condition

`mdreview open copied-file.md` works from source checkout without Wave, opens the current editor in the default browser, saves and reviews correctly, supports two views safely, preserves the embedded ledger, maintains independent Recents and preferences, recovers stale daemon state, and shuts down without a stranded Bun process. All automated checks pass. The legacy Wave viewer remains unchanged.
