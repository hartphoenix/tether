# Tether

Tether is a local Markdown review environment for human–agent dialogue. It combines a visual editor with private, durable review threads and host-neutral agent tooling.

Open a Markdown file, highlight a passage, and leave a comment. Ask your coding agent to review it; its reply appears beside the text. Resolve the thread when you're finished.

Tether currently targets macOS. Use it in Wave, cmux, or your browser, with one shared Folio and conversation store. Linux and Windows contributions are welcome; those platforms are not yet validated.

## Start using Tether

Tether is preparing its first packaged release. Until release assets are published, run from a checkout with Bun installed:

```sh
git clone https://github.com/hartphoenix/tether.git
cd tether
bun install
bun ./tether setup
```

Setup opens **Getting started with Tether** for a practice exchange. To choose the browser explicitly, run `bun ./tether setup --host browser`. Optional Wave widgets use `bun ./tether setup --wave`. To install the review skill, pass `--agent-directory` with your agent's skills directory; existing differing instructions are never overwritten. Run `bun ./tether setup --help` for options.

Come back with `bun ./tether`, or double-click **Open Tether.command**. Open a particular file with:

```sh
bun ./tether open /path/to/proposal.md
bun ./tether open /path/to/proposal.md --host browser
```

Launches start or reconnect to the local service automatically. By default, views follow your current supported terminal, using the browser outside Wave/cmux. `setup --host browser|wave|cmux|auto` saves a preference; `open --host ...` overrides it once. An unavailable requested host produces an explicit error.

If Folio says it cannot connect, run the launch command again. A browser tab cannot restart a stopped local service on its own. **Quit Tether** is available from Folio's menu; `bun ./tether doctor` reports installation and service status.

The managed release installer, runtime packaging, update/backup commands, and validation procedure are documented in [Release and recovery](docs/release.md). The eventual terminal installer and agent setup prompt use the same installer; no separate Bun installation is needed for a packaged release.

## Themes

Tether ships with four original themes: Tether Light, Tether Dark, Light Treason, and Dark Academia. It also includes Frame, Crepe, and Nord in light and dark variants, created by the [Milkdown team](https://milkdown.dev/docs/guide/using-crepe). Use the palette icon in the reader toolbar to open the theme maker and create your own.

## Current scope

Tether combines a Markdown editor, threaded review, and Folio: an active/archive document workspace. Annotations, acknowledgements, browser sessions, drafts, preferences, and Folio metadata live in private SQLite storage. Opening or commenting on a document does not add a footer or change its Markdown bytes.

Conversations use canonical file paths. An ordinary external move leaves the old conversation available through Folio's Locate action. Deliberate transfers use `.tether` packages containing Markdown and current open threads; ordinary Markdown sharing does not include Tether's private annotations. Existing legacy footers are preserved as document content, not automatically imported or removed.

## Source-checkout preview

Install dependencies, copy a Markdown file for preview use, and open it:

```sh
bun install
cp /path/to/source.md /tmp/tether-preview.md
TETHER_PROFILE=preview ./mdreview open /tmp/tether-preview.md
```

The command starts or reuses one per-profile daemon and opens the editor in the detected supported host, or the system browser. Document-scoped browser sessions survive inactive or suspended webviews; heartbeat leases report presence but do not revoke access. The daemon remains idle while sessions exist and stops explicitly. The profile config directory holds private application state; Markdown stays separate. To inspect or stop the daemon:

```sh
TETHER_PROFILE=preview ./mdreview daemon status
TETHER_PROFILE=preview ./mdreview daemon stop
```

## Wave installation

Install or refresh the four canonical Tether launchers. This atomically removes retired legacy, preview, and duplicate widget definitions while preserving unrelated widgets:

```sh
./mdreview wave status
./mdreview wave install
```

The launchers use the established `TETHER_PROFILE=preview` data profile for continuity: Tether Recents and recent positions 1–3. They launch a short-lived command block, then place the Recents page or editor in a hidden-navigation web block. Remove the Tether launchers with:

```sh
./mdreview wave uninstall
```

Record a document without opening it and synchronize the active host's recent launchers with:

```sh
TETHER_PROFILE=preview ./mdreview recents add /absolute/path/to/document.md
```

The installer preserves unrelated Wave widgets and creates a one-time `widgets.json.tether-cutover.backup`. Wave's native file navigator remains outside Tether because Wave 0.14.5 has no public file-extension routing hook.

`TETHER_RUNTIME_DIR` and `TETHER_CONFIG_DIR` can set exact private directories for an isolated run. CLI stdout is one protocol-v1 JSON object. Exit code `0` is success, `1` is an operational failure, and `2` is invalid usage.

## cmux integration

Tether currently gates cmux support to the exact verified build `0.64.22 (102) [ddd4a01bc]`. From a cmux terminal, opening a document creates or reuses one Tether review pane beside the invoking surface; later documents become tabs in that pane:

```sh
TETHER_PROFILE=preview ./mdreview open /absolute/path/to/document.md
TETHER_PROFILE=preview ./mdreview open /absolute/path/to/document.md --no-focus
```

Open Folio in cmux's right-sidebar Dock with:

```sh
TETHER_PROFILE=preview ./mdreview folio
```

Documents opened from Folio use a new tab in an existing Tether pane in the focused workspace, preferring the focused/active Tether pane when there is more than one. Without a Tether pane, they open in a new split to the right of the focused or last-active main pane. Links between local Markdown documents open a new reader tab in the source reader's current pane and add the document to Folio. Moving a reader to another workspace does not redirect its links back to its original launcher.

Local non-Markdown links use `cmux open` and its native file handling; ordinary website links retain cmux's browser behavior. Tether does not change cmux settings. In other viewing hosts, local non-Markdown links still use file reveal where available.

The Dock beta feature must be enabled in cmux. Tether reports `dock_unavailable` when it is disabled and never substitutes the system browser for requested cmux placement. Check direct and daemon-callback readiness independently:

```sh
TETHER_PROFILE=preview ./mdreview cmux status
```

Daemon callbacks use cmux's signed terminal capability through a narrow Tether bridge. The capability remains only in bridge process memory; it is not stored in launch targets, discovery records, logs, URLs, or documents.

## Agent review CLI

Use the same daemon and profile as the reader. Start with pending state, fetch the relevant thread, then use local context or an outline before requesting a full body. Commands return one protocol-v1 JSON envelope; focused help and structured command/flag descriptions come from `--help`.

```sh
TETHER_PROFILE=preview ./mdreview pending /path/to/doc.md --actor assistant
TETHER_PROFILE=preview ./mdreview thread /path/to/doc.md <thread-id>
TETHER_PROFILE=preview ./mdreview document context /path/to/doc.md <thread-id>
TETHER_PROFILE=preview ./mdreview document outline /path/to/doc.md
```

Keep the returned review cursor. After completing the review, acknowledge that cursor; do not fetch a newer cursor merely to acknowledge it. Acknowledgement records what was reviewed; resolution records whether the human still needs to read or act.

```sh
TETHER_PROFILE=preview ./mdreview reply /path/to/doc.md <thread-id> --actor assistant --body-file /tmp/reply.txt --operation-id <unique-id>
TETHER_PROFILE=preview ./mdreview acknowledge /path/to/doc.md --actor assistant --cursor <reviewed-cursor> --operation-id <another-unique-id>
```

Retry an annotation mutation with the **same operation ID and identical inputs**. A receipt lookup uses `mdreview operation <file> --operation-id <id>`. A missing receipt means `outcome_unknown`, not proof that nothing happened. Use `--expected-thread-sequence` to reject stale reply/edit/delete/resolve/reopen operations. `edit` and `delete` take both a thread ID and the original comment/reply ID. They append private review events; `delete` does not delete a Markdown file.

`actor` asserts authorship; it does not authenticate a person. Pending excludes events attributed to that actor. `consumer` owns review acknowledgements and defaults to the actor. Use `--consumer` on pending and acknowledge for independent reviewers; use the same exact string to share review progress. Case and whitespace are significant.

### Bounded recovery

`pending`, `thread`, and `threads` default to 50 items and 16 KiB of serialized result data. `--limit` accepts 1–200; `--max-bytes` accepts 2–64 KiB. The small CLI envelope is additional. `threads` returns summaries; `thread` returns current messages. Continue with the returned `--continuation` and the same document, actor/consumer or thread/filter settings. `--before-sequence` is an exclusive upper bound. Continuations preserve the observed annotation snapshot and reject changed Markdown.

Review cursors (`r-…`) and continuation tokens (`p-…`) have different purposes and expire after 30 days. A page's review cursor never crosses an incomplete or omitted event. Finish all pages before acknowledging the final reviewed cursor. Very large events/messages arrive as lossless JSON fragments: concatenate `fragment.text` in offset order, then parse the reconstructed JSON. `event <file> <event-id> --offset <returned-offset>` retrieves an immutable event in bounded fragments. Do not infer offsets yourself.

`document diff <file> --from-revision <revision>` returns a bounded change against a recently observed body. Its process-local cache holds at most 64 bodies / 32 MiB, with a 2 MiB per-body limit; it is erased on restart and conversation deletion. Unavailable revisions return `revision_unavailable` and a bounded outline, never a silent full-document read. Large changes declare omitted character counts. Context reports located, ambiguous, or orphaned anchors against current rendered text. Outline pages use the returned `nextOffset`.

`quote-candidates <file> --quote <text>` supplies bounded surrounding text and revision-bound candidate IDs. Pass the selected `--candidate-id` and `--expected-body-revision` to `comment`; no rendered offsets need to be calculated. A unique quote can be used directly. An explicitly supplied body precondition is always enforced.

### Folio and file operations

`folio list --open-threads` discovers active conversations. Directory/repository filters and sort options appear in focused help; action targets are paths, not volatile recent-list positions. `folio add` registers files without opening a reader. Registration does not grant browser access; `open` creates a document-scoped browser session. Archive hides active items and keeps their conversations indefinitely by default. Expiry is opt-in; restoring cancels it. Conversation deletion and retention erase private review data, not Markdown files. Old implicit expiry deadlines are cancelled on startup; explicit retention choices remain intact.

When moving a document you know is active in Tether's Folio, use `mdreview document move <source> <destination>` to preserve its conversation. No extra Folio checks are required for ordinary file moves; archived documents need no special handling.

Move requires an existing Tether record, an exact Markdown destination, and existing destination parents. It rejects destination files/records and cross-filesystem moves. It preserves document identity, annotations, acknowledgements, Folio state, and reader drafts. Open viewers learn the new path through their next lease response. A durable recovery journal reconciles interrupted moves on daemon restart; conflicting external changes stop recovery rather than overwrite either file. Two file names can briefly exist during publication. After an uncertain response, inspect the source/destination and Folio before repeating a move.

```sh
./mdreview folio export /path/to/doc.md --output /path/to/review.tether
./mdreview folio import --package /path/to/review.tether --directory /path/to/imports
```

Exports use exclusive creation; `--overwrite` explicitly permits atomic replacement. Import results report every completed/failed item, including partial success. Fix failed destinations and retry the same package/directory; durable per-item receipts skip successful imports, including files later edited or removed. Receipts follow relocated conversations and expire with deleted document records. Registry/host registration results are separate from file/import outcomes. `folio sync` retries host synchronization without replaying a registry mutation; statuses distinguish unsupported, skipped, succeeded, and failed.

### Limits and write guarantees

Input limits are 256 KiB review text, 64 KiB quotes, 16 MiB Markdown, and 32 MiB aggregate packages. HTTP also caps serialized requests before JSON parsing, so escaping consumes some of that allowance. Identifiers are bounded and revisions must use `sha256:<64 lowercase hex characters>`. Oversized input fails explicitly.

Annotation transactions and operation receipts commit together in SQLite. Receipts remain available for the conversation lifetime; expired review observations/continuations are reclaimed. Body saves require `--expected-body-revision` and `--body-file`; they do not use annotation operation IDs. After an uncertain body-save response, read the current body/revision before retrying. Folio mutations likewise require state inspection rather than assuming universal idempotency.

Body reads use no-follow descriptors and check canonical paths and parent identity; ordinary editor atomic replacement remains supported. Body saves recheck content/path immediately before replacement and sync the temporary file and parent directory. macOS/Linux advisory locks coordinate cooperating Tether profiles independently of their runtime directories and release on process exit. External editors do not participate: the final check and rename still have a small external-writer race. Filesystem durability depends on the filesystem/hardware; Markdown and SQLite do not form one atomic transaction.

The current pre-release agent read DTOs intentionally differ from browser snapshots: pending has one `events` list, threads are summaries, and thread messages are paginated. Browser snapshot aliases and protocol-v1 mutation receipt aliases remain for compatibility; new callers should use `appliedEventId` and `appliedSequence`. Future stable incompatible contracts require versioning. Smaller results reduce context usage; provider cache hits remain harness-specific evidence.

## Development

```sh
bun install
bun run check
bun run build:web
```

Tether is under active development. The legacy Roger viewer and queue are archived and no longer form part of the operating system.

<!-- wave-annotations:v1
{"type":"ledger","documentId":"c7f813ef-d6e3-46ce-8ead-20fef8d63450","baseBodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8","createdAt":"2026-09-03T21:12:34.013Z"}
{"type":"comment","id":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7","seq":1,"actor":"hart","createdAt":"2026-09-03T21:12:34.013Z","anchor":{"exact":"durable","prefix":". The existing wave-annotations:v1 envelope remains the current ","suffix":" document format.\nSource-checkout preview\nInstall dependencies, ","projectionStart":697,"projectionEnd":704,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-27995874-b883-4f39-b310-1a96befc7259","seq":2,"actor":"hart","createdAt":"2026-09-03T21:12:45.162Z","targetId":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7","threadId":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7"}
{"type":"comment","id":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7","seq":3,"actor":"hart","createdAt":"2026-09-03T21:13:03.214Z","anchor":{"exact":"bun install","prefix":"ependencies, copy a Markdown file for preview use, and open it:\n","suffix":"\ncp /path/to/source.md /tmp/tether-preview.md\nTETHER_PROFILE=pre","projectionStart":819,"projectionEnd":830,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-bac321d0-241d-420c-8fc6-f308fed4e0f0","seq":4,"actor":"hart","createdAt":"2026-09-03T21:13:09.350Z","targetId":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7","threadId":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7"}
{"type":"comment","id":"a-93263ea8-7925-4e0e-9152-8965e5ad7531","seq":5,"actor":"hart","createdAt":"2026-09-03T21:25:19.368Z","anchor":{"exact":"wave","prefix":"preserving unrelated widgets:\n./mdreview wave status\n./mdreview ","suffix":" install\nThe launchers use the established TETHER_PROFILE=previe","projectionStart":1686,"projectionEnd":1690,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"comment","id":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229","seq":6,"actor":"hart","createdAt":"2026-09-03T21:26:09.363Z","anchor":{"exact":"preview","prefix":"ether Recents in cmux's right-sidebar Dock with:\nTETHER_PROFILE=","suffix":" ./mdreview recents\nThe Dock beta feature must be enabled in cmu","projectionStart":3086,"projectionEnd":3093,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"‘nother test comment"}
{"type":"comment","id":"a-02b6f07b-a44b-4630-bd0f-308c42a37318","seq":7,"actor":"hart","createdAt":"2026-09-03T21:26:16.604Z","anchor":{"exact":"preview","prefix":"ect and daemon-callback readiness independently:\nTETHER_PROFILE=","suffix":" ./mdreview cmux status\nDaemon callbacks use cmux's signed termi","projectionStart":3356,"projectionEnd":3363,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"third test comment"}
{"type":"delete","id":"a-62c52b87-8ac4-4c33-b9e8-812591d0d8d7","seq":8,"actor":"hart","createdAt":"2026-09-03T21:26:57.132Z","targetId":"a-93263ea8-7925-4e0e-9152-8965e5ad7531","threadId":"a-93263ea8-7925-4e0e-9152-8965e5ad7531"}
{"type":"delete","id":"a-7aa2121c-4ed6-473f-b45a-c720c63770cf","seq":9,"actor":"hart","createdAt":"2026-09-03T21:26:59.686Z","targetId":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229","threadId":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229"}
{"type":"delete","id":"a-182a6fe2-f6aa-4c3e-814c-4a8869970768","seq":10,"actor":"hart","createdAt":"2026-09-03T21:27:02.458Z","targetId":"a-02b6f07b-a44b-4630-bd0f-308c42a37318","threadId":"a-02b6f07b-a44b-4630-bd0f-308c42a37318"}
{"type":"comment","id":"a-982f54b2-f390-4524-ac1e-904372bd7ba1","seq":11,"actor":"hart","createdAt":"2026-09-03T21:35:53.106Z","anchor":{"exact":"placement","prefix":"active Markdown viewer and review system. Phase 3 provides Wave ","suffix":", hidden navigation, a scoped Recents page, three indexed recent","projectionStart":443,"projectionEnd":452,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-6975da49-ba04-430b-a44d-2cff9f21bcef","seq":12,"actor":"hart","createdAt":"2026-09-03T21:36:02.383Z","targetId":"a-982f54b2-f390-4524-ac1e-904372bd7ba1","threadId":"a-982f54b2-f390-4524-ac1e-904372bd7ba1"}
{"type":"comment","id":"a-9976bc9f-608e-4142-997f-3454144c7769","seq":13,"actor":"hart","createdAt":"2026-09-03T21:36:26.440Z","anchor":{"exact":"visual","prefix":"down review environment for human–agent dialogue. It combines a ","suffix":" editor with private, durable review threads and host-","projectionStart":93,"projectionEnd":99,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test"}
{"type":"delete","id":"a-03736d2f-9329-4061-b5fe-237e30cc53fb","seq":14,"actor":"hart","createdAt":"2026-09-03T21:36:31.378Z","targetId":"a-9976bc9f-608e-4142-997f-3454144c7769","threadId":"a-9976bc9f-608e-4142-997f-3454144c7769"}
{"type":"comment","id":"a-34500b7f-e510-4b46-88a9-c9225521bceb","seq":15,"actor":"hart","createdAt":"2026-09-03T21:58:52.974Z","anchor":{"exact":"threads","prefix":"combines a visual editor with durable, document-embedded review ","suffix":" and host-neutral agent tooling.\nThe first implementation is bei","projectionStart":146,"projectionEnd":153,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-3c3e96cf-99af-4c9a-9791-61c65583e084","seq":16,"actor":"hart","createdAt":"2026-09-03T21:58:56.952Z","targetId":"a-34500b7f-e510-4b46-88a9-c9225521bceb","threadId":"a-34500b7f-e510-4b46-88a9-c9225521bceb"}
{"type":"comment","id":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5","seq":17,"actor":"hart","createdAt":"2026-09-03T21:59:24.818Z","anchor":{"exact":"threads","prefix":"combines a visual editor with durable, document-embedded review ","suffix":" and host-neutral agent tooling.\nThe first implementation is bei","projectionStart":146,"projectionEnd":153,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"comment"}
{"type":"delete","id":"a-f1616d1d-a758-4e5f-b700-eb6f30229dfc","seq":18,"actor":"hart","createdAt":"2026-09-03T21:59:27.993Z","targetId":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5","threadId":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5"}
{"type":"comment","id":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34","seq":19,"actor":"hart","createdAt":"2026-09-03T22:03:24.349Z","anchor":{"exact":"combines","prefix":" local Markdown review environment for human–agent dialogue. It ","suffix":" a visual editor with private, durable review threads ","projectionStart":82,"projectionEnd":90,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"this is a test comment, reply to say hi to aaron"}
{"type":"reply","id":"a-efd62e5f-9e75-46ea-8075-668a2376c938","seq":20,"actor":"assistant","createdAt":"2026-09-03T22:05:48.433Z","threadId":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34","body":"Hi, Aaron.\n"}
{"type":"ack","id":"a-f7d2599e-c8d0-4e56-ae22-19ba66101d19","seq":21,"actor":"assistant","throughSeq":19,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8","createdAt":"2026-09-03T22:05:56.327Z"}
{"type":"resolve","id":"a-1b6c0912-c9df-4aee-852d-0c38844c7e3d","seq":22,"actor":"hart","createdAt":"2026-09-03T22:06:21.279Z","threadId":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34"}
{"type":"comment","id":"a-56027870-b8e7-4f42-b21f-f711fb7431a3","seq":23,"actor":"hart","createdAt":"2026-09-05T00:03:16.723Z","anchor":{"exact":"Markdown","prefix":"Tether\nTether is a local ","suffix":" review environment for human–agent dialogue. It combines a visu","projectionStart":25,"projectionEnd":33,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment for checking out ui zoom behavior"}
-->
