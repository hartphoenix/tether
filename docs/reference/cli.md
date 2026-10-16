# Tether CLI reference

[Documentation](../README.md) · [Protocol details](protocol.md)

Use `tether` from an installed package, or `./tether` and `./mdreview` from a source checkout. Run commands under the same OS account and `TETHER_PROFILE` as the reader. To install the optional review skill, see [agent setup](../guide/agent-setup.md).

Start with `tether --help` to find a command group, then use focused help such as `tether reply --help` for its exact flags. Replace the uppercase ID placeholders in these examples with the values Tether returns.

## Review comments

Pending identifies changed events without returning their bodies or anchors. Read each affected thread once when current text is needed. If you're missing passage context, ask for nearby text or an outline before reading the full document.

```sh
tether pending /path/to/doc.md --actor assistant
tether thread /path/to/doc.md THREAD_ID
tether document context /path/to/doc.md THREAD_ID
tether document outline /path/to/doc.md
```

Follow every continuation before acknowledging. Each page of pending events has its own review cursor. Once you've handled that page and all preceding pages, acknowledge the last fully reviewed page's cursor. Don't start a fresh pending read just to get a newer cursor.

An index is not completed review. Handle every listed event or assign a clear next owner before acknowledging. Check `reviewState` even when `events` is empty: `changed` supplies `acknowledgedBodyRevision` for `document diff --from-revision`; if that revision is unavailable, inspect relevant body content. `never_reviewed` requires inspecting relevant document content before acknowledging. A later thread read may contain newer events; keep using the original pending cursor.

Use `event FILE EVENT_ID` for immutable historical details when current thread text is insufficient. An edit event contains its edited text; a deletion identifies its target. Reading that `targetId` returns the original message, so inspect intervening edit events when their text matters. Resolution/deletion metadata alone may suffice when no text-dependent action remains.

Acknowledgement records what the agent has reviewed. Resolution records whether the human still needs to read or act on a thread.

```sh
tether reply /path/to/doc.md THREAD_ID --actor assistant --body-file /tmp/reply.txt --operation-id UNIQUE_ID --expected-thread-sequence THREAD_SEQUENCE
tether acknowledge /path/to/doc.md --actor assistant --cursor REVIEWED_CURSOR --operation-id ANOTHER_UNIQUE_ID
```

If you retry an annotation change, keep the same operation ID and identical inputs. Look up its receipt with `tether operation <file> --operation-id <id>`. A missing receipt means `outcome_unknown`; the change may still have happened. A replayed receipt's `appliedSequence` is historical; refresh the thread before another guarded write.

Use `--expected-thread-sequence` to reject stale replies, edits, deletions, resolutions, or reopenings. Both `edit` and `delete` take a thread ID and the original comment or reply ID. They append private review events; `delete` leaves the Markdown file alone.

The `actor` value names the author without authenticating them. Pending results exclude that actor's events. The `consumer` value identifies whose acknowledgements to track and defaults to the actor. Use `--consumer` on pending and acknowledge to track reviewers independently, or use the exact same string to share progress. Case and whitespace matter.

## Read and save a document

Use `document context`, `outline`, or `diff` to read just what you need. When you need the full body and its revision, use `tether document read /path/to/doc.md`. Save a replacement body with:

```sh
tether document save /path/to/doc.md --expected-body-revision BODY_REVISION --body-file /tmp/revised.md
```

Pass the `sha256:` revision you read; Tether rejects a save if it's stale. If you're unsure whether a save succeeded, check the current body and revision before retrying.

## Register finished documents

```sh
tether recents add /path/to/doc.md
```

This adds the document to Folio and synchronizes the applicable host without opening a view. Running `tether recents` alone opens Folio. Use `tether folio list` to check which documents are registered.

For local embedding, `tether folio --url` (also `tether recents --url`) returns `{url, expiresAt}` in the usual result envelope without opening a view or starting a host bridge. `--host` selects the target for subsequent document opens; focus flags have no placement effect with `--url`. The URL contains a one-use launch ticket, valid for 30 seconds: consume it immediately and do not log or persist it. Its redirect establishes a scoped browser cookie; the final Folio URL requires that cookie to work.

## Folio and file operations

Conversations are identified by canonical file paths. If you move a file outside Tether, reconnect its conversation through Folio's Locate action. Tether treats annotation footers already in a Markdown file as file content; it doesn't import their comments.

Use `folio list --view active --open-threads` to find active entries with open conversations. Omit `--view active` to include archived entries. Focused help lists directory and repository filters and sort options. Address documents by path, since positions in the recent list can change.

Use `folio add` to register files without opening a reader. Registration alone doesn't grant browser access; `open` creates a browser session for that document. Archiving hides an active item and keeps its conversation indefinitely by default. Expiry is optional, and restoring an item cancels it. Conversation deletion and retention remove private review data while leaving Markdown files in place.

Use `tether document move <source> <destination>` when you know a document is active in Folio and want to move it with its conversation. You don't need to check Folio before ordinary file moves or handle archived documents specially.

The move command needs an existing Tether record and an unused Markdown destination on the same filesystem. The destination's parent directories must already exist. If you're unsure whether the move succeeded, check both paths and Folio before retrying.

```sh
tether folio export /path/to/doc.md --output /path/to/review.tether
tether folio import --package /path/to/review.tether --directory /path/to/imports
```

Exports refuse an existing destination unless you pass `--overwrite`, which allows atomic replacement. Import results tell you which items succeeded and which failed. Fix failed destinations and retry the same package and directory. Saved receipts let Tether skip successful imports, even if you've since edited or removed those files. Receipts follow moved conversations and expire when their document records are deleted.

Check registry and host registration results separately from file and import outcomes. Use `folio sync` to retry host synchronization without repeating the registry change. Its status distinguishes unsupported, skipped, succeeded, and failed operations.

## Agent skill updates

Use `tether skills list` to find pending skill reviews and `tether skills read ID` to read the installed and proposed instructions, their `sourceRevision`, and the merge prompt. See [agent setup](../guide/agent-setup.md#skill-updates) for the review choices.

After the user approves the merged instructions in your conversation, apply the candidate with:

```sh
tether skills merge ID --expected-revision SOURCE_REVISION --body-file /path/to/merged-skill.md --confirm
```

The command checks that the installed and proposed instructions still match the source revision, installs the merge, and clears the review notice. If either source changed, read and compare again; renew approval if the resulting merge changes. Do not bypass a conflict by substituting a fresh revision without reviewing it.

## Profiles and failures

The default profile is `preview`, with `default` as an alias. Use the same `TETHER_PROFILE` value across commands when isolating work. The `TETHER_CONFIG_DIR` and `TETHER_RUNTIME_DIR` overrides name the exact private directories, not just profile names.

Stdout contains one protocol-v1 JSON envelope. Check `ok`, the exit code, individual item results, and warnings. An error can arrive after some work has succeeded. See [protocol details](protocol.md) for pagination, diagnostics, mutation receipts, and durability limits.

## Workspace recovery and startup

- `tether resume --inspect`: list existing cmux panes that would be reloaded, without starting a stopped daemon or navigating.
- `tether resume`: start the service, attach cmux, and reload existing Tether panes that show an error page, using their saved cookies.
- `tether startup status`: report whether login startup is enabled and loaded, whether the daemon is running, and whether cmux is attached. Starts nothing.
- `tether startup enable`: start Tether at login for the current packaged installation, and write the cmux shell hook. Safe to repeat.
- `tether startup disable`: remove the login job and the shell hook. Running processes keep running; `tether daemon stop` stops them.
- `tether cmux attach`: entry point for the shell hook. Starts the service if needed and attaches this cmux terminal's authority.

See [recovery](../guide/recovery.md). Tether never edits your shell startup files.

## Paseo plugin channel (experimental)

The Tether plugin for Paseo uses these commands. Paseo can't be driven from outside, so Tether queues each open as an *intent* and the plugin pulls it. The commands and their data shapes may change between releases.

- `tether paseo status`: report whether a plugin is connected (`present`) and how many intents are pending. It never starts the service.
- `tether paseo wait [--after <cursor>] [--folio <version>] [--timeout <seconds>]`: return intents newer than `--after`. It returns early when an intent arrives or Folio changes past `--folio`. The timeout is at most 25 seconds. A wait marks the plugin connected for 30 seconds.
- `tether paseo ack <intent-id>...`: remove intents the plugin has handled. An unacknowledged intent expires with its launch ticket.
- `tether paseo theme <client-id> <theme-id|unknown>`: report the mounted desktop client’s palette for optional theme inheritance. The client ID is a persistent UUID, not an authorization token; unknown palettes preserve the last inherited theme.

Inside Paseo, `tether open` picks the `paseo` host automatically when the plugin is connected, or explicitly with `--host paseo`. Opens that the plugin makes for the user open a reader tab. Any other open, such as an agent's, only lights the workspace's Tether button and reports `notified: true`, so Tether never moves your focus. `tether recents add` does the same inside Paseo and reports `announced: true`. Links clicked in a Paseo reader open as new tabs directly from the reader.

### Chat annotation storage

`tether paseo chat <json-file|->` is the plugin’s internal storage channel. A request contains `host`, `agent` and `operation`; `-` reads bounded JSON from stdin. It calls the authenticated Tether daemon, which alone owns the chat tables in its private SQLite database. The result is `{ drafts, submission }`.

Operations are `read`, `save` (draft), `remove` (draft ID), `capture` (batch ID, prose, attachment metadata), `dispatch` (batch ID, native message ID, text, wire options), `accepted` (matching batch/message IDs), `cancelPrepared` (batch ID) and `deleteChat`. Captured drafts are immutable; dispatch precedes transport, and acceptance deletes only that batch. `cancelPrepared` rejects uncertain delivery. `deleteChat` is reserved for confirmed permanent chat deletion and fences subsequent stale writes. Validation and state conflicts return `chat_state`. Requests are scoped by daemon and agent, independently of document paths and review ledgers.

## Installer setup

`tether setup --no-open` reports host discovery, update-channel configuration, and optional integration guidance while preserving focus. A configured update channel is not a live connectivity check; use `tether update --check` for that.

`--agent-directory /absolute/skills` keeps its existing review-skill behavior. Add `--skills tetherball` to accept both skills, or `--skills tether-review,tetherball` explicitly. Setup reports `agents` with each identity/path/result and retains the legacy `agent` field for the review skill. Neither skill is installed without the directory flag.

The installer runs `tether setup --release-notes`, which also copies the current release notes into Tether's documents folder, adds them to Folio, and opens them after the welcome guide. The optional Tetherball offer appears only in that release-notes reader.

`--paseo` accepts installation of the packaged plugin into the local Paseo daemon. It preserves unmanaged installations and the global plugin switch. `hosts` distinguishes installation, version, active environment, and known connection state; `null` means a connection was not probed. `warnings` reports optional integration steps that need attention even when core setup succeeds.

## Visual evidence

`tether visual <file> <thread-id> [--mode overview|crop|clean] [--offset <count>] [--history <index>]` retrieves a private PNG artifact. The default overview contains at most 12 numbered regions, with a longest side of 1200 pixels. `regions` maps each number to `threadId`, a bounded comment excerpt and the normalized `{x,y,width,height}` rectangle. Grouping uses block occurrence and saved visual revision, not image content alone. `nextOffset` is null at the end of the group. `--history 0` retrieves the oldest retained anchor for that thread.

The result includes `status`, `artifact` (an absolute local path), `mimeType`, `mode`, `visualRevision`, `evidence`, original `width`/`height`, `attachment` and `verification`. `attachment` is `located`, `stale` or `orphaned`; `verification: unverified` explicitly distinguishes a saved capture from a verified current rendering. Load `artifact` using the agent's image tool. Use `--mode crop` for the selected pixels or `--mode clean` for the unmarked base visual. No detail derivative is generated by `pending`, `thread`, or the default overview. Missing evidence and invalid or oversized exports return errors.

The browser's annotation endpoint also accepts `type: reanchor`, with `threadId`, `anchor`, `expectedBodyRevision`, `expectedThreadSequence` and `operationId`. It retains the original comment and derives the effective anchor from subsequent events. Visual creation and replacement additionally require `evidenceData` (base64 PNG) and `currentVisualRevision`; local image anchors carry the revision recorded when their pixels were served. Evidence and the event commit in one private-store transaction. A stale body, thread sequence or loaded local-image revision rejects the mutation; operation receipts make retries idempotent.

Visual anchors extend quote locators with a versioned `visual` record: kind, source identity, original occurrence count, layout revision, evidence hash, pixel dimensions, optional SVG viewBox and normalized rectangle. Package version 2 carries retained events and their referenced evidence; version 1 remains supported for text reviews. Unknown package versions and visual-anchor versions are rejected.
