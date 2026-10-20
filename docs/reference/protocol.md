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

### Review results

Ordinary review commands return the following bounded data inside the protocol-v1 envelope. The CLI and daemon ship together; update both when adopting this contract. Host/Folio results and browser snapshots keep their existing shapes.

| Command | Data |
| --- | --- |
| `pending` | `bodyRevision`, `acknowledgedBodyRevision`, `reviewState`, indexed `events`, `cursor`, `throughSequence`, `continuation` |
| `thread` | `bodyRevision`, `thread: {id, status, sequence}`, complete `messages`, `continuation` |
| `threads` | `bodyRevision`, summaries in `threads`, `continuation` |
| Annotation mutations | `mutation: {operationId, appliedEventId, appliedSequence, replayed}` |
| `operation` | `operationId`, `outcome`, canonical `receipt` or null |
| `document save` | `path`, resulting `bodyRevision` |
| `help` | Command names/groups at top level, group syntax, or focused syntax; no repeated reporting guidance |

Warnings and additional outcome information are preserved. Other commands pass through unchanged, including raw `event`, document reads/context/diffs, host operations, launch results, diagnostics, and partial import outcomes. Stored receipts and browser snapshots remain unchanged; agent control responses use the canonical fields above.

An indexed event has `id`, `seq`, `type`, `actor`, `threadId`, and `targetId` for edits/deletions. A root comment's `threadId` is its own ID. Bodies, anchors, and timestamps remain available through thread/context/event reads. Index construction occurs before byte budgeting, so long comment bodies do not inflate the index. Unusually long metadata can still fragment losslessly under the rules below. Do not treat seeing an index entry as reviewing its content.

Pending continuations bind actor/consumer and document state. Old raw-event continuation tokens cannot be reused for index reads; restart the read if a continuation is rejected.

`acknowledgedBodyRevision` is null before the first acknowledgement. `reviewState` is `never_reviewed`, `current`, or `changed`, independently of whether events are pending. Review relevant body changes before acknowledging their revision. Thread reads can observe events newer than the pending snapshot; acknowledge only the pending cursor actually handled.

### Pages and fragments

`pending`, `thread`, and `threads` default to 50 items and 16 KiB of serialized result data. Use `--limit` for 1–200 items and `--max-bytes` for 2–64 KiB. The small CLI envelope adds to that size.

The `threads` command returns summaries; `thread` returns current messages. To read another page, pass the returned `--continuation` with the same document and actor/consumer or thread/filter settings. The `--before-sequence` bound includes only sequences below the value you specify. Continuations keep the annotation snapshot from the original read and reject a read if the Markdown has changed.

Review cursors (`r-…`) and continuation tokens (`p-…`) serve different purposes; both expire after 30 days. A page's review cursor never advances past an incomplete or omitted event. Finish all pages before acknowledging the final reviewed cursor.

Large events and messages arrive as lossless JSON fragments. Join `fragment.text` in offset order, then parse the reconstructed JSON. Use `event <file> <event-id> --offset <returned-offset>` to retrieve an immutable event in bounded fragments. Always use the returned offsets.

Use `document diff <file> --from-revision <revision>` to get a bounded change from a recently observed body. The cache lives in the process and holds at most 64 bodies or 32 MiB, with a 2 MiB limit per body. Restarting clears it; deleting a conversation clears its cached bodies.

If a revision is unavailable, the result includes `revision_unavailable` and a bounded outline instead of the full document. Large changes report how many characters were omitted. Context results describe anchors as located, ambiguous, or orphaned against the current rendered text. Use the returned `nextOffset` for another outline page.

### Reader body attribution

The authenticated reader endpoint `GET api/revisions?from=BODY_REVISION` returns `{base, revisions}`. `base` contains `bodyRevision` and `body`; each subsequent revision contains `bodyRevision`, `parentRevision`, `authorId`, `savedAt` (Unix milliseconds), `body`, and `open`. Revisions run oldest first through the current disk body. An unavailable base returns `{base:null,revisions:[]}`; the reader uses neutral attribution.

The private database retains body history across restarts and document moves. Signed `document save` calls record the caller's stable role ID, including after takeover; reader saves record the human. Direct disk changes are attributed to the sole active Go turn on that document. This is an inference from turn activity, not proof of which process wrote the file. Overlapping turns, writes outside a turn, and changes first observed after a restart are neutral.

Unpublished disk observations within one turn coalesce into an open revision. Turn completion captures the final body and closes it. A body already returned to a reader remains available as a base, so a turn may contain more than one retained checkpoint. Explicit saves are separate revisions. The daemon observes disk bodies on reads and turn transitions; it does not preserve every intermediate filesystem write.

`POST api/reviewed` with `{bodyRevision}` marks a completed reader review. The daemon retains that version, its 50 predecessors, and every later revision; failed or unfinished reviews do not advance retention. `GET api/identities?ids=…` resolves revision authors to current names, icons and colors, and `identityRevision` in reader change responses invalidates cached identities after renaming. These endpoints also work through authenticated shared readers.

Use `quote-candidates <file> --quote <text>` to get bounded surrounding text and candidate IDs tied to a body revision. Pass your chosen `--candidate-id` and `--expected-body-revision` to `comment`, without calculating rendered offsets. You can use a unique quote directly. Tether always enforces a body precondition if you supply one.

## Limits and write guarantees

Input limits are 256 KiB for review text, 64 KiB for quotes, 16 MiB for Markdown, and 32 MiB for packages in aggregate. HTTP also limits serialized requests before parsing JSON, so escaped characters use some of that allowance. Identifiers have size limits, and revisions must use `sha256:<64 lowercase hex characters>`. Tether rejects oversized input explicitly.

Annotation changes and their operation receipts commit together in SQLite. Receipts last for the conversation's lifetime; Tether removes expired review observations and continuations. Body saves require `--expected-body-revision` and `--body-file` and don't use annotation operation IDs. If a save's outcome is uncertain, read the current body and revision before retrying. Check Folio state before retrying an uncertain mutation there, too; not every operation is safe to repeat blindly.

Body reads use no-follow descriptors and check canonical paths and parent identity. Ordinary atomic file replacement by an editor is supported. A body save rechecks the file’s contents and path immediately before replacement. It also syncs the temporary file and parent directory.

OS advisory locks coordinate cooperating Tether profiles even if they use different runtime directories. The locks release when the process exits. External editors don't participate, so an external write can still race with the final check and rename. Durability depends on the filesystem and hardware; a Markdown write and a SQLite change aren't one atomic transaction.

Agent read results differ from browser snapshots. Pending returns one `events` list, threads returns summaries, and thread messages arrive in pages. Use `appliedEventId` and `appliedSequence`. Smaller results use less context, but provider cache hits still need evidence from the specific harness.
