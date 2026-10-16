# Architecture and code map

[Contributor setup](../../CONTRIBUTING.md)

Each OS user and Tether profile gets one local daemon. The CLI and the browser clients share its document and review services, and host adapters place views in Paseo, cmux, Wave or a browser.

| Area | Source | Responsibility |
| --- | --- | --- |
| Commands | [`src/cli/`](../../src/cli/) | Public entry point, argument contracts, setup, results, backup |
| Service | [`src/server/`](../../src/server/) | Daemon lifecycle, authenticated routes, persisted views |
| Documents | [`src/documents/`](../../src/documents/) | Scoped access, body saves, moves, bounded reads, packages |
| Review model | [`src/core/`](../../src/core/) | Annotation events, anchors, Markdown projection |
| Private state | [`src/storage/`](../../src/storage/) | SQLite conversations, receipts, acknowledgements, settings |
| Chat annotations | [`src/chat/`](../../src/chat/) | Daemon-owned storage for Paseo chat annotations |
| Folio | [`src/recents/`](../../src/recents/) | Membership, retention, freshness, host synchronization |
| Hosts | [`src/hosts/`](../../src/hosts/) | Capability reporting, placement, authenticated bridges |
| Reader | [`src/web/`](../../src/web/) | Milkdown editor, threads, Folio, themes, reconnection |
| Shared contracts | [`src/shared/`](../../src/shared/) | Types, validation, diagnostics, theme definitions |
| Updates | [`src/releases/`](../../src/releases/) | Signed update verification |
| Paseo plugin | [`integrations/paseo/`](../../integrations/paseo/) | Folio and reader panels, chat annotations, themes; see its [README](../../integrations/paseo/README.md) |
| Packaging | [`scripts/`](../../scripts/) | Builds and checks; publisher implementation in `scripts/releases/` |
| Verification | [`tests/`](../../tests/) | Unit, integration, browser and failure-boundary tests |

## State and authorization

Markdown stays at the path the user chose. Tether's private SQLite store holds comments, acknowledgement cursors, Folio state and reader recovery data. The document body and its conversation carry separate revisions. Opening or commenting on a document never changes its Markdown bytes; a save checks the expected body revision, then replaces the file atomically.

An explicit path-scoped operation, such as `tether open`, grants access to that file; a Folio entry alone grants none. Tether identifies each conversation by its file's canonical path, and the document service carries that identity through an intentional move. Mutations to a path run one at a time, even when several views have the document open.

Browser leases record that a view is present without granting authority, so a suspended view or a missed heartbeat never revokes a document session. Tether persists authorization verifiers, never bearer cookies, and keeps host capabilities in process memory. When a host can't place a view, the adapter returns an explicit result.

## Agent and host boundaries

Agents start from pending state, fetch individual threads, and read bounded context, outlines or diffs, with the full body available when they need it. Changes must preserve the pagination, operation receipts and stale-write checks described in [protocol details](../reference/protocol.md), and changes to public contracts need compatible versioning.

To register a document for the user, call `recordRecent()` or run `tether recents add`; the lower-level registry doesn't synchronize host views. Terminal-specific behavior lives in host adapters, which keeps document and review code independent of any host.

## Documentation and package contents

`src/onboarding.ts` copies the [walkthrough](../getting-started.md) into the user's Tether documents folder as their own practice file, and setup copies the current release notes beside it. Image and document links in both must work from that folder. `scripts/build-release.ts` selects the docs that ship: the walkthrough, the current release notes and both agent skills. Contributor docs and private work records stay out of installed packages. License notices ship with the code and assets they cover.
