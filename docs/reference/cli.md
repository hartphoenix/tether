# Tether CLI reference

[Documentation](../README.md) · [Protocol details](protocol.md)

Use `tether` from an installed package, or `./tether` and `./mdreview` from a source checkout. Run commands under the same OS account and profile as the reader. To install the optional review skill, see [agent setup](../guide/agent-setup.md).

Start with `tether --help` to find a command, then use focused help such as `tether reply --help` for its exact flags. Replace the uppercase ID placeholders in these examples with the values Tether returns.

## Review comments

Read pending comments first, then fetch the thread you need. If you're missing context, ask for nearby text or an outline before reading the full document.

```sh
tether pending /path/to/doc.md --actor assistant
tether thread /path/to/doc.md THREAD_ID
tether document context /path/to/doc.md THREAD_ID
tether document outline /path/to/doc.md
```

Follow every continuation before acknowledging. Each page of pending events has its own review cursor. Once you've handled that page and all preceding pages, acknowledge the last fully reviewed page's cursor. Don't start a fresh pending read just to get a newer cursor.

Acknowledgement records what the agent has reviewed. Resolution records whether the human still needs to read or act on a thread.

```sh
tether reply /path/to/doc.md THREAD_ID --actor assistant --body-file /tmp/reply.txt --operation-id UNIQUE_ID
tether acknowledge /path/to/doc.md --actor assistant --cursor REVIEWED_CURSOR --operation-id ANOTHER_UNIQUE_ID
```

If you retry an annotation change, keep the same operation ID and identical inputs. Look up its receipt with `tether operation <file> --operation-id <id>`. A missing receipt means `outcome_unknown`; the change may still have happened.

Use `--expected-thread-sequence` to reject stale replies, edits, deletions, resolutions, or reopenings. Both `edit` and `delete` take a thread ID and the original comment or reply ID. They append private review events; `delete` leaves the Markdown file alone.

The `actor` value names the author without authenticating them. Pending results exclude that actor's events. The `consumer` value identifies whose acknowledgements to track and defaults to the actor. Use `--consumer` on pending and acknowledge to track reviewers independently, or use the exact same string to share progress. Case and whitespace matter.

## Read and save a document

Use `document context`, `outline`, or `diff` to read just what you need. When you need the full body and its revision, use `tether document read /path/to/doc.md`. Save a replacement body with:

```sh
tether document save /path/to/doc.md --expected-body-revision BODY_REVISION --body-file /tmp/revised.md
```

Pass the `sha256:` revision you read; Tether rejects a save if it's stale. If you're unsure whether a save succeeded, check the current body and revision before retrying.

## Shared profiles

See [shared-profile setup](../guide/shared-profile.md) for owner enrollment, client pairing, connectors, and supervised startup. Shared commands take `--connection <private-credential-file>`; use `id:<document-uuid>` for existing documents or a path with `--machine <machine-uuid>` to register a file on that machine. Credentials never belong in a document URL.

Shared saves also require `--expected-location-version` from the preceding read. Keep both original revisions and the attempted text after an uncertain response:

```sh
tether document save id:DOCUMENT_ID --connection CONNECTION_FILE --expected-body-revision BODY_REVISION --expected-location-version LOCATION_VERSION --body-file /tmp/revised.md
tether document verify-save id:DOCUMENT_ID --connection CONNECTION_FILE --expected-body-revision BODY_REVISION --expected-location-version LOCATION_VERSION --body-file /tmp/revised.md
```

Verification waits behind earlier connector work and reports `matches_edit`, `matches_base`, or `diverged`; it does not replay the save. Retry explicitly only when the current file still matches the original base. A relink changes the location version, so reopen before editing the replacement location.

`document history id:DOCUMENT_ID --connection CONNECTION_FILE` reads historical reviews even when the file machine is unavailable. Use `--thread THREAD_ID` for messages, `--continuation TOKEN` for the next page, and `--limit` / `--max-bytes` for bounded output. These responses have no current body or anchor context.

`document relink id:DOCUMENT_ID DESTINATION --machine MACHINE_ID --connection CONNECTION_FILE` verifies an accessible replacement location and preserves reviews. It refuses a location already associated with another document. Archived destinations require explicit restoration before a new reader opens them; registration accepts `--restore` for that choice. Managed file moves remain local operations.

## Register finished documents

```sh
tether recents add /path/to/doc.md
```

This adds the document to Folio and synchronizes the applicable host without opening a view. Running `tether recents` alone opens Folio. Use `tether folio list` to check which documents are registered.

For local embedding, `tether folio --url` (also `tether recents --url`) returns `{url, expiresAt}` in the usual result envelope without opening a view or starting a host bridge. `--host` selects the target for subsequent document opens; focus flags have no placement effect with `--url`. The URL contains a one-use launch ticket, valid for 30 seconds: consume it immediately and do not log or persist it. Its redirect establishes a scoped browser cookie; the final Folio URL requires that cookie to work.

## Folio and file operations

Conversations have stable document IDs; local commands also accept canonical file paths. If you move a file outside Tether, reconnect its conversation through Folio's Locate action. Tether treats annotation footers already in a Markdown file as file content; it doesn't import their comments.

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
