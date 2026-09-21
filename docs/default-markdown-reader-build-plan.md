# Default Markdown reader: build plan

2026-09-21 · Recommendations accepted; implementation not started

Make Tether the default Markdown reader within a supported host through one reversible checkbox in Folio Settings and one yes/no question during agent-assisted installation. Full routing depends on new host capabilities; do not ship partial interception under this label.

## Evidence and limits

| Host | Evidence inspected | Missing capability |
|---|---|---|
| Wave 0.14.5 | Installed app source maps and settings schema; upstream preview and CLI source | File-picker and directory navigation update native preview metadata directly; Markdown rendering is hardcoded; no configurable Markdown handler found |
| cmux 0.64.25, build 106, commit `b685a275c` | Installed binary setting names; upstream configuration and terminal routing source | Editor preferences offer partial redirection, but no comprehensive Markdown-specific handler found; exact-build source retrieval failed |

Roger commit `c00c4ca` and its archived Wave implementation cover widgets, Recents, and custom reader links. The archived extraction plan explicitly excludes native file-navigator routing. No evidence found that the old implementation covered that path.

Sources: [Wave preview](https://github.com/wavetermdev/waveterm/blob/main/frontend/app/view/preview/preview-model.tsx), [Wave CLI](https://github.com/wavetermdev/waveterm/blob/main/cmd/wsh/cmd/wshcmd-view.go), [cmux configuration](https://github.com/manaflow-ai/cmux/blob/main/web/data/cmux.schema.json), [cmux terminal routing](https://github.com/manaflow-ai/cmux/blob/main/Sources/TerminalLinkOpenCoordinator.swift).

These are static findings, not end-to-end verification. Pin host source revisions and verify actual coverage before implementation. Current upstream source may differ from installed builds.

## Product contract

- Label: **Make Tether the default Markdown reader for cmux** or **…for Wave**; host identity comes from the Folio session's launch target, not the daemon's environment or browser user agent.
- Enabled: covered host opens launch Tether and register the canonical file in Folio; non-Markdown behavior remains unchanged.
- Disabled: future host opens resume the previous native routing; existing readers stay open; Folio launches continue using Tether.
- Independent setting per host installation, with one owning Tether installation/profile; other profiles report ownership instead of competing for the setting.
- Unsupported hosts/builds: disabled control with a short explanation; never report activation without verified host registration.
- Initial format scope: local `.md` and `.markdown`; evaluate `.mkd` parity, including Folio validation; keep MDX native until lossless editing is demonstrated, and disclose exclusions beside the control.
- Remote files retain native handling until a connection-aware transport exists; ordinary HTTP links remain websites, even when their URL ends in `.md`.

## Implementation sequence

### 1. Add host-owned routing hooks

Prepare upstream changes separately for Wave and cmux, with a generic external-reader contract rather than a Tether-specific dependency. Registration must be user-scoped and versioned, carry source placement and connection identity, and run before native rendering.

| Host | Required interception paths |
|---|---|
| Wave | File-picker selection; directory double-click/Return; local reader and terminal links; `wsh view/open/preview`; Markdown preview block creation and file metadata navigation |
| cmux | Terminal path and `file:` links; explorer/search opens; native reader links; generic file-open and Markdown-open CLI/API paths; file drag-open |

Audit explicit edit commands and restored views separately: preserve explicit editor intent and existing restored readers rather than rerouting them accidentally. Cover every path that otherwise chooses the native Markdown reader. Do not use application-bundle patches, shell-command shadowing, or post-open polling/replacement as the production mechanism.

**Gate:** pinned source, route-level tests, and a compatible host build exposing the hook; upstream acceptance or release timing remains external to Tether.

### 2. Implement Tether's handoff and adapter capability

Extend `src/hosts/host-adapter.ts`, `host-gateway.ts`, and shared contracts with routing support, covered paths/formats, observed status, and enable/disable operations. Keep host mutations inside adapters and their authorized bridges.

Use a stable installed launcher with structured arguments, source placement, and a request ID. Reuse scoped document opening and `recordRecent()`; handle paths as data, preserve focus policy, and deduplicate retries. Distinguish completed, declined, failed, and unknown outcomes: native fallback only after a definite non-open result, never blindly after a timeout. Reuse existing host authorization without widening socket access or granting browser callers arbitrary path-opening authority.

### 3. Make activation reversible

Probe support before mutation; save prior values and ownership; write atomically; verify effective host state before reporting enabled. Restore only values still owned by Tether, preserving later user changes. Recover interrupted operations and detect missing launchers, conflicting owners, and host upgrades. Uninstall removes the owned registration and restores prior routing.

### 4. Add Settings and installation flow

Expand `src/web/folio-page.ts` Settings beyond archive retention; keep routing changes independent from destructive retention changes. Load observed status when opening Settings and refresh it after each operation; distinguish unavailable, disabled, enabled, and repair-needed states.

Expose the same compact status/enable/disable operation through the CLI and authenticated Folio API. In `src/cli/setup.ts` and bundled agent installation guidance, offer: **Make Tether the default Markdown reader for [host]? Yes / No** only when coverage is supported, with format/local-file scope stated once. Default to no change without an answer; do not repeat an already-recorded choice on routine upgrades. Preserve locally customized agent guidance.

### 5. Verify and release by host

Test every listed entry path both enabled and disabled, checking correct pane/focus, exactly one reader, Folio registration, and unchanged non-Markdown handling. Include spaces, Unicode, symlinks, missing files, rapid repeats, line/fragment links, remote paths, unsupported formats, multiple windows/profiles, restart, upgrade, uninstall, configuration conflicts, and uncertain handoff outcomes.

Run adapter, CLI, HTTP, lifecycle, and rollback tests plus `bun run check`; validate native UI paths manually in compatible hosts, without Playwright or Chromium launches under the current restriction. Ship each host only after its complete coverage matrix passes; keep the other unavailable until its gate passes.

## Completion criterion

One yes/no choice or checkbox enables verified routing for the declared scope, survives restart, and reverses cleanly without changing Folio behavior or unrelated host preferences. No implementation, upstream submission, or host configuration change has been made by this planning task.
