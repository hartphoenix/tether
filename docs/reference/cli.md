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

## Register finished documents

```sh
tether recents add /path/to/doc.md
```

This adds the document to Folio and synchronizes the applicable host without opening a view. Running `tether recents` alone opens Folio. Use `tether folio list` to check which documents are registered.

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
