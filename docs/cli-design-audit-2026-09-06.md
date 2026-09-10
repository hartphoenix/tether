# CLI audit

**Verified:** 2026-09-07

**Scope:** source-checkout CLI, private review storage, document operations, daemon transport, and Folio.

The recommended build is implemented. The complete check passes 244 tests, TypeScript, and the production web build. Astra reviewed the integration; identified regressions were corrected and covered by targeted tests. This establishes the tested behavior below, not a guarantee against arbitrary filesystem failures or external writers.

## Implemented

| Area | Current behavior |
| --- | --- |
| Command design | Strict specifications generate focused help and structured command descriptions. Literal `--help` after `--` stays literal; unsupported mutation consumer flags are rejected. Parsing and bounded file/stdin IO are separate from dispatch. |
| Bounded review | Pending events, current thread messages, and thread summaries use deterministic byte budgets, SQL-backed queries, and snapshot-bound continuations. Oversized items have lossless JSON fragments. Acknowledgement never advances across an incomplete event. |
| Progressive recovery | Outline, current anchor context/status, immutable event retrieval, and bounded revision differences supplement thread reads. Unavailable revisions return an explicit bounded outline fallback. |
| Review correctness | Observation ordering is independent of event sequence, including migrated cursors. Older same-sequence body observations cannot regress acknowledgements. Agent results distinguish never reviewed, current, and changed. |
| Retry semantics | Annotation operation receipts survive restart; mismatched operation-ID reuse conflicts. Receipt lookup distinguishes applied from unknown outcomes. Transport failures preserve uncertainty and recovery details. |
| Storage lifetime | Review observations and continuations expire after 30 days and are reclaimed. Annotation receipts remain for the conversation lifetime. Conversation deletion invalidates continuations and clears the volatile revision cache. |
| Document relocation | `document move` preserves document ID, private conversation, acknowledgements, receipts, Folio state, reader authorization, and drafts. It refuses overwrites and cross-filesystem moves. A durable journal reconciles interruption between file publication and SQLite update. |
| File access | No-follow descriptor reads validate canonical paths and parent identity. Restored browser grants also check stored parent identity. Ordinary editor atomic saves remain supported. Folio title reads reject symlink redirection. |
| Write coordination | Kernel advisory locks coordinate cooperating macOS/Linux profiles through one per-user location independent of profile/TMPDIR. Locks cover saves, moves, and move recovery and release when a process exits or crashes. |
| Durability | Body replacement syncs its temporary file and parent directory. Move publication uses exclusive hard links and directory sync. Existing destination files are never silently overwritten. |
| Package operations | Exports publish atomically with exclusive creation unless `--overwrite` is explicit. Imports report each completed/failed item and retain durable per-item retry receipts. Folio registration failures remain separate from committed import outcomes. The browser reports partial imports accurately. |
| Host synchronization | Explicit unsupported/skipped/succeeded/failed statuses; `folio sync` retries host work without repeating registry mutations. A separate ordered host queue lets registry reads/writes proceed during slow host calls. |
| Legacy registry import | Missing JSON state differs from corrupt/unreadable state. Unsuccessful imports do not set the completion marker and can be retried after repair. |
| Transport and validation | Shared launch/control timeout and cancellation behavior, bounded request/response buffering, runtime success checks, input limits, stable domain errors, and conflict revision/sequence details. Unexpected storage failures are not reported as bad user input. |
| Authoring | CLI edit/delete target original comment/reply IDs with operation IDs and optional thread preconditions. Quote candidates provide bounded context and revision-bound IDs; supplied body preconditions are enforced. |
| Discovery and guidance | `--open-threads` matches the UI terminology. README and agent guidance describe private storage, cursor review, retry rules, Folio, `.tether` transfers, and the brief active-document move convention. |

## Contracts and deliberate limits

**Reads.** Pending/thread/list results default to 50 items and 16 KiB. Configurable bounds are 1–200 items and 2–64 KiB; the CLI envelope is additional. Continuations and review cursors are distinct, expire after 30 days, and bind their original document/snapshot/read settings. Thread listing returns summaries; a selected thread returns current messages. Fragment offsets are supplied by the service and must not be inferred by callers.

**Revision recovery.** The diff cache is process-local, with at most 64 bodies / 32 MiB total / 2 MiB per body. It is not persistent document history. Restart, eviction, or larger bodies can produce `revision_unavailable`. Large changes declare omitted character counts. These responses reduce context usage; they do not establish provider cache hits.

**Retry scope.** Annotation mutation receipts commit with the event or acknowledgement. Missing receipts remain `outcome_unknown`. Body saves and Folio mutations do not claim the same operation-ID guarantee: inspect current state after an uncertain response. Import replay skips prior completed items even if they were later edited or removed; deleting the document record ends that replay guarantee.

**Moves.** The CLI accepts an exact Markdown destination with existing parent directories. It preserves one existing conversation, never merges conversations, and rejects cross-filesystem moves. Two names can briefly reference the same file during publication. A restart reconciles recorded intermediate states; conflicting external changes stop recovery rather than overwrite files. After an uncertain response, inspect the named paths and Folio before repeating the command.

**Filesystem boundary.** SQLite and Markdown are not one atomic transaction. Cooperating Tether writers share locks; external editors do not. A narrow race remains between the final external-content check and filesystem replacement. File/directory syncing improves crash durability but cannot guarantee hardware or filesystem behavior. Tests simulate interrupted move phases and a killed writer; they do not simulate physical power failure.

**Privacy and authorship.** Annotations remain private application data unless explicitly exported. Actor names are asserted authorship, not authentication; consumer strings own independent or shared review progress. No account system or automatic file-move surveillance was introduced.

**Compatibility.** The pre-release agent read DTOs are separate from browser snapshots. Browser aliases and protocol-v1 mutation receipt aliases remain; new clients should use `appliedEventId` and `appliedSequence`. A future stable incompatible contract needs versioning. MCP remains deferred until the public contracts settle, then should wrap the same services with fixed schemas.

## Verification coverage

The suite retains existing authentication, scoped-session, concurrent-thread, private-storage, draft-recovery, import-collision, and external-write coverage. Added tests exercise bounded pagination and fragmentation, same-sequence acknowledgement ordering, cursor expiry, actual diff/fallback reads, quote disambiguation, edit/delete/receipt CLI integration, destination protection, partial import replay/registration, move state preservation and interrupted phases, cross-process writer locks and crash release, live and restored grant redirection, host queue independence/retry, and recoverable legacy migration.

Implementation is in `src/cli/`, `src/documents/agent-reads.ts`, `src/documents/document-move.ts`, `src/documents/safe-files.ts`, `src/documents/path-lock.ts`, `src/documents/package-import.ts`, `src/storage/private-store.ts`, `src/server/`, and `src/recents/`. Operational examples and exact limits are in `README.md`; focused command usage is available through `mdreview <command> --help`.

<!-- wave-annotations:v1
{"type":"ledger","documentId":"018046a3-9566-4f57-b99a-a7d721469bc6","baseBodyRevision":"sha256:98c2721bc185edc678e0236666cf959a133682d3d6f8da25a16d11b4004046eb","createdAt":"2026-09-06T20:35:36.565Z"}
{"type":"comment","id":"a-3bf92d3f-2ab6-4603-81e9-56556f571e79","seq":1,"actor":"hart","createdAt":"2026-09-06T20:35:36.565Z","anchor":{"exact":" acknowledge CLI, control actions, ledger acknowledgement validation.","prefix":"review while still reporting the newer body as unread.\nEvidence:","suffix":"\n3. Give mutations explicit retry and concurrency semantics. Hig","projectionStart":4235,"projectionEnd":4304,"bodyRevision":"sha256:98c2721bc185edc678e0236666cf959a133682d3d6f8da25a16d11b4004046eb"},"body":"links like these should pass through to cmux’s default rather than get caught in the daemon’s ip (which produces an error \"{\"error\":{\"code\":\"session_expired\",\"message\":\"The browser session has expired.”}}”)"}
-->
