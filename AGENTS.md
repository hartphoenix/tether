# Contributor-agent guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md), then the [architecture and code map](docs/contributing/architecture.md). Run `git status --short --branch` before editing; preserve unrelated work. Verify claims against source and tests. Keep changes focused, and do not commit or publish without authorization.

## Implementation boundaries

- Keep document, review, storage, and web behavior independent of terminal hosts; use capability-reporting host adapters.
- Preserve path-scoped authorization, per-path mutation serialization, independent body/review revisions, conflict checks, and private review storage.
- Keep credentials out of files, URLs, logs, fixtures, and tool output. Presence signals must not revoke document access.
- Use `recordRecent()` or the public CLI for user-visible registration so host synchronization follows the registry update.
- Keep agent reads progressive and bounded. Do not claim provider cache hits from Tether behavior alone.

## Reviewing documents

When asked to handle Tether comments, use the [review skill](integrations/agents/tether-review/SKILL.md) and [CLI reference](docs/reference/cli.md). Use the reader's account and profile. Keep passage-specific responses in their threads; leave a thread open when the human still needs to read or act. Move known active documents through `document move` to preserve their conversations.

## Verification and documentation

Run `bun run check` before reporting a working state; add the relevant checks from CONTRIBUTING for host, geometry, or packaging changes. Report what passed and any unverified behavior. Inspect the final diff.

Keep user documentation in `docs/guide/`, CLI contracts in `docs/reference/`, and reusable contributor guidance in `docs/contributing/`. Link from the [documentation map](docs/README.md); keep the installed walkthrough brief. Put personal plans and development records under ignored `.local/`, and do not copy local maintainer instructions into public guidance.
