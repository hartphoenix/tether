# Architecture and code map

[Contributor setup](../../CONTRIBUTING.md)

Tether has one local daemon per OS user and profile. The CLI and browser clients share its document and review services. Host adapters handle placement in a browser, cmux, or Wave.

| Area | Source | Responsibility |
| --- | --- | --- |
| Commands | [`src/cli/`](../../src/cli/) | Public entry point, argument contracts, setup, results, backup |
| Service | [`src/server/`](../../src/server/) | Daemon lifecycle, authenticated routes, persisted views |
| Documents | [`src/documents/`](../../src/documents/) | Scoped access, body saves, moves, bounded reads, packages |
| Review model | [`src/core/`](../../src/core/) | Annotation events, anchors, Markdown projection |
| Private state | [`src/storage/`](../../src/storage/) | SQLite conversations, receipts, acknowledgements, settings |
| Folio | [`src/recents/`](../../src/recents/) | Membership, retention, freshness, host synchronization |
| Hosts | [`src/hosts/`](../../src/hosts/) | Capability reporting, placement, authenticated bridges |
| Reader | [`src/web/`](../../src/web/) | Milkdown editor, threads, Folio, themes, reconnection |
| Shared contracts | [`src/shared/`](../../src/shared/) | Types, validation, diagnostics, theme definitions |
| Updates | [`src/releases/`](../../src/releases/) | Signed update verification |
| Packaging | [`scripts/`](../../scripts/) | Builds and checks; publisher implementation in `releases/` |
| Verification | [`tests/`](../../tests/) | Unit, integration, browser, and failure-boundary tests |

## State and authorization

Markdown stays at the selected path. Private SQLite storage holds comments, acknowledgement cursors, Folio state, and reader recovery data. Track body and conversation revisions independently. Opening or commenting must leave the Markdown bytes untouched; saves check the expected revision before replacing the file atomically.

An explicit path-scoped operation grants file access. A Folio entry alone grants none. Canonical paths identify conversations. The document service carries that identity through an intentional move. Serialize mutations for each real path, even when several views have the same document open.

Browser leases indicate presence, not authority. Suspended views and missed heartbeats must not revoke document sessions. Persist authorization verifiers, not bearer cookies; keep host capabilities in process memory. Unsupported placement must produce an explicit result.

## Agent and host boundaries

The review API lets agents start with pending state, fetch individual threads, and read bounded context, outlines, or diffs. Full bodies are available when needed. Preserve pagination, operation receipts, and stale-write checks described in [protocol details](../reference/protocol.md). Changes to public contracts need compatible versioning.

Use `recordRecent()` or `tether recents add` when registering a document for the user. The lower-level registry does not synchronize host views. Keep terminal-specific behavior in adapters so document and review code stays independent of the host.

## Documentation and package contents

The [walkthrough](../getting-started.md) becomes a user-owned practice file when `src/onboarding.ts` copies it. Its image and help links need to work from that location. `scripts/build-release.ts` explicitly selects the runtime docs to include; keep contributor docs and private work records out of installed packages. Include license notices with the code and assets they cover.
