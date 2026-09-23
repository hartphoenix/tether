# CLI protocol details

[CLI workflow](cli.md)

Use this reference to read paginated results, work out what succeeded after an error, or build a CLI client.

## Responses and diagnostics

`TETHER_RUNTIME_DIR` and `TETHER_CONFIG_DIR` can set exact private directories for an isolated run. CLI stdout is one protocol-v1 JSON object. Exit code `0` is success, `1` is an operational failure, and `2` is invalid usage.

Registration returns the paths it added. It leaves out the rest of the registry and routine terminal-integration details:

```json
{"protocol":1,"ok":true,"command":"recents.add","data":{"added":[{"path":"/absolute/path/to/document.md"}]}}
```

If registration succeeds but a terminal shortcut update fails, `data.warnings` describes the failure and includes diagnostics. Unsupported or unnecessary shortcut updates produce no warning. Use `folio list` to inspect the registry and `folio sync` for synchronization diagnostics.

An import can report overall command success even when some items fail. Its result still includes each item's success or failure and the overall import outcome.

Errors have a stable `error.code` and a readable message. When available, `error.details.diagnostic` includes the underlying filesystem or transport codes, syscall, path, and child exit status. HTTP status appears in `error.details.httpStatus`. Diagnostics redact known credential forms and indicate when output has been truncated to fit a limit.

For commands with several steps, `details.completed` lists the steps known to have finished. The `details.outcome` value distinguishes `not_applied`, `partially_applied`, `applied`, and `outcome_unknown` when the outcome can be established. An export that was written but failed directory synchronization reports `applied` and `durability: "unconfirmed"`. An error here doesn't mean the file is absent.

If a recorded daemon can't be reached, Tether reports a reachability error. It doesn't assume the daemon has stopped or start another process.

## Pagination and bounded reads

`pending`, `thread`, and `threads` default to 50 items and 16 KiB of serialized result data. Use `--limit` for 1–200 items and `--max-bytes` for 2–64 KiB. The small CLI envelope adds to that size.

The `threads` command returns summaries; `thread` returns current messages. To read another page, pass the returned `--continuation` with the same document and actor/consumer or thread/filter settings. The `--before-sequence` bound includes only sequences below the value you specify. Continuations keep the annotation snapshot from the original read and reject a read if the Markdown has changed.

Review cursors (`r-…`) and continuation tokens (`p-…`) serve different purposes; both expire after 30 days. A page's review cursor never advances past an incomplete or omitted event. Finish all pages before acknowledging the final reviewed cursor.

Large events and messages arrive as lossless JSON fragments. Join `fragment.text` in offset order, then parse the reconstructed JSON. Use `event <file> <event-id> --offset <returned-offset>` to retrieve an immutable event in bounded fragments. Always use the returned offsets.

Use `document diff <file> --from-revision <revision>` to get a bounded change from a recently observed body. The cache lives in the process and holds at most 64 bodies or 32 MiB, with a 2 MiB limit per body. Restarting clears it; deleting a conversation clears its cached bodies.

If a revision is unavailable, the result includes `revision_unavailable` and a bounded outline instead of the full document. Large changes report how many characters were omitted. Context results describe anchors as located, ambiguous, or orphaned against the current rendered text. Use the returned `nextOffset` for another outline page.

Use `quote-candidates <file> --quote <text>` to get bounded surrounding text and candidate IDs tied to a body revision. Pass your chosen `--candidate-id` and `--expected-body-revision` to `comment`, without calculating rendered offsets. You can use a unique quote directly. Tether always enforces a body precondition if you supply one.

## Limits and write guarantees

Input limits are 256 KiB for review text, 64 KiB for quotes, 16 MiB for Markdown, and 32 MiB for packages in aggregate. HTTP also limits serialized requests before parsing JSON, so escaped characters use some of that allowance. Identifiers have size limits, and revisions must use `sha256:<64 lowercase hex characters>`. Tether rejects oversized input explicitly.

Annotation changes and their operation receipts commit together in SQLite. Receipts last for the conversation's lifetime; Tether removes expired review observations and continuations. Body saves require `--expected-body-revision` and `--body-file` and don't use annotation operation IDs. If a save's outcome is uncertain, read the current body and revision before retrying. Check Folio state before retrying an uncertain mutation there, too; not every operation is safe to repeat blindly.

Body reads use no-follow descriptors and check canonical paths and parent identity. Ordinary atomic file replacement by an editor is supported. A body save rechecks the file’s contents and path immediately before replacement. It also syncs the temporary file and parent directory.

OS advisory locks coordinate cooperating Tether profiles even if they use different runtime directories. The locks release when the process exits. External editors don't participate, so an external write can still race with the final check and rename. Durability depends on the filesystem and hardware; a Markdown write and a SQLite change aren't one atomic transaction.

Agent read results differ from browser snapshots. Pending returns one `events` list, threads returns summaries, and thread messages arrive in pages. Use `appliedEventId` and `appliedSequence`. Smaller results use less context, but provider cache hits still need evidence from the specific harness.
