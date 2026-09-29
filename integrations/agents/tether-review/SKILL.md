---
name: tether-review
description: Use Tether to prepare documents for responses with multiple independently reviewable items, edit local Markdown, handle comments or review notes, and register and open documents for review. Read this skill when first using Tether in a session; reuse these instructions (without rereading) for subsequent actions. Reread *only* if they are no longer available in context, including after compaction.
---

Use the installed `tether` CLI with actor `assistant`, in the same user account and profile as the reader. A source checkout also provides `mdreview`. Commands return one JSON envelope; inspect `ok` and the exit code. Use focused `--help` for exact flags.

Report partial success accurately; distinguish completed actions from warnings and failures.

## Choosing chat or a document

Prefer Tether when a response contains multiple substantive items the user may need to discuss, decide, or track independently. Use chat for brief answers, status, and isolated questions. Judge by the review work required, not a rigid word count or bullet count; a response approaching a page should prompt this assessment. Honor the user's requested response format.

Reuse the relevant document in context when the response serves its existing purpose. Continue existing comment threads for passage-specific discussion. Incorporate authorized changes in the appropriate sections; keep proposals visibly distinct from accepted decisions. Create a linked companion document when the material has a separate purpose or would obscure the original document's use; link back to the original.

Make new work easy to find. For substantive body changes, maintain a short “Current review” section near the top identifying changed sections and remaining decisions. Replace stale summaries rather than accumulating updates. Preserve unresolved content and active comment anchors.

Register the document with `tether recents add <file>` and open it with `tether open <file>` when handing it over for review, using the reader's configured profile and host. Keep chat to a brief handoff with the document link and exact review location; don't duplicate the document. If opening fails, report that accurately and provide the path. Handle document selection and placement unless there is a material ambiguity.

## Reviewing and editing

For comment review, start with `tether pending <file> --actor assistant`, then fetch each relevant thread with `tether thread <file> <thread-id>`. Follow all continuation pages before acknowledging; after every event is handled or has a clear next owner, acknowledge the last fully reviewed page’s cursor. Do not fetch a fresh pending snapshot merely to obtain a newer cursor. Continuation tokens are not acknowledgement cursors.

Prefer `document context`, `outline`, or `diff` over a full read; after context loss, rediscover the document and fetch current review state.

Reply using `reply <file> <thread-id> --actor assistant --body-file <text-file> --operation-id <unique-id>`. Use returned thread sequences with `--expected-thread-sequence` for stale-write protection. Retry an uncertain mutation with the same operation ID and identical inputs, or inspect `operation <file> --operation-id <id>`. A missing receipt does not prove nonapplication.

Keep passage-specific replies in their threads. Put substantive global synthesis and cross-thread decisions in the relevant document; use chat for brief handoffs, blockers, and verification. Resolve only when the human no longer needs to read or act on the thread. Answered questions stay open for the human to read. Orphaned threads remain replyable. Acknowledgement and resolution are independent.

Body saves require `document save <file> --expected-body-revision <revision> --body-file <file>`. Review data lives in private SQLite; never edit it directly or add annotation footers to Markdown. Use `document move` when deliberately moving an active Tether document. After uncertain file operations, inspect current state before retrying.

Use `tether recents add <file>` to register a document without opening a view. A shortcut-update warning does not undo successful registration; inspect `data.warnings` separately. Bare `tether recents` opens the Recents view and is not a registration check.

Use `[[../path/file.md|Label]]` for Tether wikilinks; verify paths relative to the containing document, keep spaces literal, and omit heading fragments. Standard Markdown links also work; local non-Markdown links use the host’s file handling (native open in cmux, file reveal where supported elsewhere).

Keep formatting readable in Tether:

- Math is not currently supported in Tether. Write every literal dollar sign as `\$` in document bodies and replies (`\$20`, not `$20`); an unescaped pair of dollar signs garbles the text between them.
- Do not use Mermaid code blocks for diagrams; Milkdown renders them as plain text.
- Do not use tables or code blocks in thread replies; use prose, lists, or inline code instead.
- Use at most four columns in tables in document bodies to keep them readable.

Opening starts the service and follows the configured host; honor focus requests and report unsupported placement rather than substituting another host.
