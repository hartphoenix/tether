# Tether agent guidance

## Cold start

Read [README.md](README.md) and the current status and implementation checkpoint in [docs/product-plan.md](docs/product-plan.md). Run `git status --short --branch` before acting; preserve existing work and verify plan status against the code and tests rather than assuming either is current.

The legacy Wave viewer remains the daily-use fallback until cutover. Never edit the same real Markdown file concurrently through the legacy viewer and Tether because their separate processes cannot serialize each other's writes.

## Architecture invariants

- Run one daemon per OS user and profile. Multiple documents and multiple views of one document share that daemon and its per-real-path mutation queue.
- Keep the document model, review model, daemon API, and web client host-neutral. Wave, cmux, and later environments belong behind capability-reporting adapters.
- An explicit path-scoped operation grants file access. Recents is a convenience index and never grants read or write authority.
- Keep Markdown-body and annotation-ledger revisions independent. Preserve the terminal embedded ledger and use conflict-checked, atomic body saves.
- Treat browser leases and release events as presence signals only. Missed heartbeats, suspended webviews, reloads, and laptop sleep must not revoke a document-scoped session.
- Report unsupported host capabilities explicitly. Do not silently substitute a system-browser action for a requested embedded-host action.

## Review workflow

Use actor `assistant`. Start with compact state and escalate only as needed:

1. Run `mdreview pending <file> --actor assistant`.
2. Fetch each relevant thread with `mdreview thread <file> <thread-id>`.
3. Reply in the thread when the information is local to that passage. Keep global status and cross-document context in the conversation rather than duplicating it in both places.
4. Read the full document only when pending state and individual threads do not provide enough context.
5. Acknowledge only through the exact sequence and body revision that were actually reviewed.

Resolution is the user's attention state, not the assistant's work queue:

- Resolve a thread only when it requires no further reading or action from the user.
- Leave a thread open when the user still needs to read a response, answer a question, make a decision, or perform an action. In particular, answering a user's question does not by itself resolve the thread.
- A completed instruction may be resolved when its result needs no further user attention.
- Acknowledgement means the assistant has seen events; it is independent of resolution.
- `orphaned` means the thread's document location was lost. It is independent of open/resolved state, and orphaned threads remain replyable.

Use revision-safe CLI operations documented in [README.md](README.md). Do not edit the embedded JSONL ledger directly when the daemon API or CLI can perform the operation.

## Recents and host synchronization

A user-visible recent-document addition is one application operation: update the product registry, then synchronize the active host. Use `recordRecent()` inside the application or `mdreview recents add <file>` from the CLI. Do not call `RecentsRegistry.add()` directly for a user-visible action; that lower-level method intentionally has no host side effects.

Before cutover, modify only Tether's `tether-preview-*` Wave widget IDs. Do not replace or remove the legacy Markdown or Recents widgets. Wave credentials remain in process memory only: never place `WAVETERM_JWT`, launch tickets, or control credentials in logs, configuration, widget definitions, discovery records, URLs, or test fixtures.

## Context-efficiency contract

Read [docs/references/provider-cache-behavior.md](docs/references/provider-cache-behavior.md) before changing agent protocols, tool schemas, context loading, artifact revision handling, or cache-related product claims. The current assessment and prioritized gaps are in [docs/cache-fidelity-audit-2026-09-01.md](docs/cache-fidelity-audit-2026-09-01.md).

Tether primarily optimizes incremental context fidelity: it should deliver the smallest sufficient artifact delta, thread state, or local context. Provider prefix-cache preservation is valuable but indirect and harness-dependent. Do not claim that a file edit on disk itself invalidates Codex or Claude Code's existing conversation cache.

Keep agent interaction progressive: pending state first, then one thread, then bounded local context or revision delta, and a full artifact only when necessary. Keep MCP/tool names, schemas, descriptions, and ordering stable; dynamic artifact state belongs in results, not tool definitions.

Treat provider cache-hit metrics as adapter-specific evidence. Never infer a hit from Tether behavior alone. Design cold-session and post-compaction recovery as first-class paths.

## Verification

Run the complete check before reporting a working state:

```sh
mkdir -p "$TMPDIR/bun-tmp"
TMPDIR="$TMPDIR/bun-tmp" bun run check
```

The HTTP, lifecycle, and daemon tests bind temporary loopback ports and may require the execution sandbox's network permission. Inspect the actual diff after tests. Do not overwrite unrelated dirty work, and do not commit or push unless the user or orchestrator requests it.
