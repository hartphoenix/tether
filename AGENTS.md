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

After mobile reader, Folio, or shared code changes that affect mobile, update the configured local phone staging service before reporting completion. Follow [the mobile staging refresh procedure](docs/contributing/phone-staging.md): preserve its configuration, restart it from the working checkout, and verify health plus the changed behavior at its existing URL. This local staging refresh is part of implementation and needs no separate approval. Do not substitute a source build or isolated test for updating the running staging service. If staging cannot be refreshed, report the blocker explicitly. This instruction does not authorize production deployment, signing, or publication.

Keep user documentation in `docs/guide/`, CLI contracts in `docs/reference/`, and reusable contributor guidance in `docs/contributing/`. Link from the [documentation map](docs/README.md); keep the installed walkthrough brief. Put personal plans and development records under ignored `.local/`, and do not copy local maintainer instructions into public guidance.
