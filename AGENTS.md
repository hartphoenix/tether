# Contributor-agent guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md), then the [architecture and code map](docs/contributing/architecture.md). Run `git status --short --branch` before editing; preserve unrelated work. Verify claims against source and tests. Keep changes focused, and do not commit or publish without authorization.

## Implementation boundaries

- Treat current implementations as revisable choices, not permanent constraints. Recommend changes to architecture, storage, schema, or language when they materially improve the intended product; explain migration costs and trade-offs without expanding scope for speculative future needs.
- Keep document, review, storage, and web behavior independent of terminal hosts; use capability-reporting host adapters.
- Preserve path-scoped authorization, per-path mutation serialization, independent body/review revisions, conflict checks, and private review storage.
- Keep credentials out of files, URLs, logs, fixtures, and tool output. Presence signals must not revoke document access.
- Use `recordRecent()` or the public CLI for user-visible registration so host synchronization follows the registry update.
- Keep agent reads progressive and bounded. Do not claim provider cache hits from Tether behavior alone.

## Icons

Use the local Phosphor source pack at `.local/phosphor-icons/` for interface icons, with regular-weight SVGs by default. Keep the collection untracked; copy only the icons needed by the application into `src/web/icons.ts`, retaining the existing Phosphor license attribution.

## Reviewing documents

When asked to handle Tether comments, use the [review skill](integrations/agents/tether-review/SKILL.md) and [CLI reference](docs/reference/cli.md). Use the reader's account and profile. Keep passage-specific responses in their threads; leave a thread open when the human still needs to read or act. Move known active documents through `document move` to preserve their conversations.

## Verification and documentation

Run `bun run check` before reporting a working state; add the relevant checks from CONTRIBUTING for host, geometry, or packaging changes. Report what passed and any unverified behavior. Inspect the final diff.

Phone work is suspended project-wide until Hart explicitly changes this instruction. Do not start, restart, refresh, or set up the phone staging server. Exclude phone tests, phone staging checks, mobile-viewport checks, and physical-phone verification, including after changes to shared reader or Folio code. Use `bun run test` or `bun run check`, which exclude phone/mobile tests; do not substitute an unfiltered `bun test`. Run Go-reader browser checks with `--desktop`. Preserve the phone implementation and configuration. Skipped phone verification is intentional and is not a completion blocker. This supersedes earlier instructions to refresh phone staging automatically.

Keep user documentation in `docs/guide/`, CLI contracts in `docs/reference/`, and reusable contributor guidance in `docs/contributing/`. Link from the [documentation map](docs/README.md); keep the installed walkthrough brief. Put personal plans and development records under ignored `.local/`, and do not copy local maintainer instructions into public guidance.
