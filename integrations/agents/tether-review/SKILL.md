---
name: tether-review
description: Use Tether to create or revise Markdown documents, respond to document comments, and register/edit files for review. Use whenever Tether is requested, but not when a brief chat answer suffices.
---

Use `tether` (`./mdreview` in a source checkout), actor `assistant`, and the reader's OS account and `TETHER_PROFILE`. Preserve the configured host. Inspect `ok`, exit status, and warnings; partial success can accompany an error. Use focused help, such as `tether reply --help`, for unfamiliar flags.

## Documents and attention

Use Tether for work the user may discuss, decide, or track in separate parts. Reuse the relevant document and its comment threads; use a linked companion for a separate purpose. Keep proposals distinct from accepted decisions. After substantive revisions, replace the short “Current review” section near the top with changed sections and remaining decisions. Links are available to help readers navigate: Current review can link to the sections it names, and wikilinks can connect companion and related documents. Preserve unresolved content and active anchors.

Register finished documents without opening a view:

```sh
tether recents add /absolute/path/document.md
```

Bare `recents` opens Folio. Use `folio list` to discover registered documents. Never steal focus or bypass agent-origin safeguards; open/refresh only when focus is preserved or the user requests a focus change. Report unsupported placement. Keep chat to a document link and review location.

## Review comments

Replace uppercase placeholders with returned values:

```sh
tether pending FILE --actor assistant
tether thread FILE THREAD_ID
```

Pending is an event index, not reviewed content. Follow every `continuation` using the same command, actor/consumer and `--continuation TOKEN`. Read each affected thread once when current text is needed, following its pages too. Handle every indexed event or give it a clear next owner. Resolution/deletion metadata can suffice when no text-dependent action remains. A thread may contain newer events than the pending snapshot.

For historical text, `event FILE EVENT_ID` returns that immutable event. An edit includes its new text; a deletion only identifies its target. `event FILE TARGET_ID` retrieves the original message, not subsequent edits; inspect relevant edit events when those versions matter.

Check `reviewState` even when `events` is empty. For `changed`, inspect `document diff FILE --from-revision ACKNOWLEDGED_BODY_REVISION`; if unavailable or insufficient, read relevant body/context. For `never_reviewed`, inspect relevant document content. Leave the cursor unacknowledged if necessary review remains.

```sh
tether reply FILE THREAD_ID --actor assistant --body-file /tmp/reply.txt --operation-id UNIQUE_ID --expected-thread-sequence THREAD_SEQUENCE
tether acknowledge FILE --actor assistant --cursor REVIEWED_CURSOR --operation-id ANOTHER_UNIQUE_ID
```

Acknowledge the last fully handled pending page's cursor after handling that page and preceding pages, including body review. Never fetch fresh pending merely for a newer cursor. Continuation tokens are not acknowledgement cursors. Reading alone does not acknowledge anything.

If a page contains `fragment`, join `fragment.text` in offset order across continuation pages and parse the reconstructed JSON; do not treat fragments as complete events/messages. For `event` fragments, use `--offset NEXT_OFFSET` until `nextOffset` is null.

Keep passage-specific replies in threads and broader synthesis in the document. Acknowledgement records review; resolution closes human attention. Leave answers/results open when the human still needs to read, decide, or act. Resolve completed instructions only when no review remains. Orphaned threads remain replyable.

## Safe edits and recovery

Use `thread.sequence` for guarded writes. Retry uncertain annotation mutations with the same operation ID and identical inputs, or inspect `operation FILE --operation-id ID`. A missing receipt means `outcome_unknown`. A replayed receipt's `appliedSequence` is historical; refresh the thread before the next guarded write.

Prefer `document context FILE THREAD_ID`, `outline`, or `diff` for bounded reading. Before replacing the body, obtain current content and `bodyRevision` with `document read FILE`, then save:

```sh
tether document save FILE --expected-body-revision BODY_REVISION --body-file /tmp/revised.md
```

On conflict, reread and reconcile; never overwrite intervening edits. After uncertain file operations, inspect actual state before retrying. Review data is private SQLite: never edit it directly or add annotation footers. Use `document move SOURCE DESTINATION` when moving an active Tether document to keep its conversation.

## Rendering

Document links resolve relative to their file: `[Section](other.md#heading)` or `[[../path/file.md|Label]]`. Use `document outline` for heading anchors; keep spaces literal in wikilinks. Local non-Markdown links use the host's file handling. Use a Mermaid diagram or an embedded image when a structure, flow or comparison is hard to follow in prose. Documents support Mermaid and math; escape literal dollar signs (`\$20`). Replies support Markdown tables/code, but not rendered Mermaid/math or document-relative link navigation. Prefer narrow tables for readability.

Read this skill once per session and reuse its instructions throughout. Reread only when they are no longer in context, including after compaction.
