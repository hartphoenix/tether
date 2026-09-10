---
name: tether-review
description: Review and respond to comments on local Markdown documents in Tether when the user asks to handle Tether comments or review notes.
---

Use the installed `tether` CLI with actor `assistant`, in the same user account and profile as the reader. A source checkout also provides `mdreview`. Commands return one JSON envelope; inspect `ok` and the exit code. Use focused `--help` for exact flags.

Start with `tether pending <file> --actor assistant`, then fetch each relevant thread with `tether thread <file> <thread-id>`. Keep the returned review cursor. Follow all continuation pages with the same inputs before acknowledging their complete contents. Review cursors and continuation tokens are different; do not substitute one for the other or fetch a new cursor merely to acknowledge it.

If the thread lacks enough context, use `document context`, `document outline`, or `document diff` before a full `document read`. After a fresh session or lost context, rediscover the document through the user's path or `folio list`; rebuild understanding from pending state and bounded reads. Do not assume old cursors or cached body revisions remain available.

Reply using `reply <file> <thread-id> --actor assistant --body-file <text-file> --operation-id <unique-id>`. Use returned thread sequences with `--expected-thread-sequence` for stale-write protection. Retry an uncertain mutation with the same operation ID and identical inputs, or inspect `operation <file> --operation-id <id>`. A missing receipt does not prove nonapplication.

Keep passage-specific replies in their threads and global decisions in the conversation. Resolve only when the human no longer needs to read or act on the thread. Answered questions stay open for the human to read. Orphaned threads remain replyable. Acknowledge the fully reviewed cursor only after each thread is handled or has a clear next owner; acknowledgement and resolution are independent.

Body saves require `document save <file> --expected-body-revision <revision> --body-file <file>`. Review data lives in private SQLite; never edit it directly or add annotation footers to Markdown. Use `document move` when deliberately moving an active Tether document. After uncertain file operations, inspect current state before retrying.

Use `[[../path/file.md|Label]]` for Tether wikilinks; verify paths relative to the containing document, keep spaces literal, and omit heading fragments. Standard Markdown links also work; local non-Markdown files reveal in Finder.

Opening a document starts the local service. `tether open <file> --host browser` explicitly selects the browser; normal opens follow the launch preference/current terminal. Respect focus requests with `--no-focus`. Unsupported host placement must be reported, not silently replaced. Do not modify terminal layouts or credentials to work around an unavailable adapter.
