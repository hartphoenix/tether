# CLI error and outcome audit

Date: 2026-09-13

Scope: source-checkout CLI input parsing, file/stdin input, daemon discovery/startup, authenticated HTTP control, server error translation, Folio registration, and launch/setup output. This is a diagnosis; no additional runtime fixes were applied during this audit.

## Finding

The final CLI formatter already passes through an error's string `code`, message, and `details`. Most information loss occurs before that boundary. The startup-lock catch fixed earlier was one example, not the only one.

The normal path is `mdreview` → `runCli` → argument validation/local input → `controlRequest` → daemon operation → server error translation → HTTP response → CLI JSON envelope. Local-only commands skip the daemon. Stdout is deliberately one protocol-v1 JSON object; exit codes are 0 for success, 1 for operational failure, and 2 for usage errors. Tether is a structured application interface, not a transparent subprocess-output relay.

## Fixes needed

### 1. Recents turns validation errors into misleading internal failures

Source: [registry.ts](../src/recents/registry.ts), `addMany`; [server.ts](../src/server/server.ts), `controlError`.

`addMany` catches every `stat`/`realpath` failure and throws an uncoded “does not exist” error, conflating missing files, denied access, and other filesystem failures. A non-Markdown extension also produces an uncoded error. The daemon then replaces these with `internal_error`, a storage-related message, and `outcome_unknown`.

Reproduced through an isolated real daemon: `recents add <missing.md>` returned `internal_error` with “Check storage availability before retrying” and `outcome_unknown`. No registration had been attempted: all paths are validated before the database transaction.

Fix: preserve filesystem causes, code non-file/extension validation explicitly, and report `not_applied` for pre-mutation validation failures.

### 2. Discovery and startup cannot explain an unreachable daemon

Source: [config.ts](../src/server/config.ts), `readDiscovery` and `readControlToken`; [lifecycle.ts](../src/server/lifecycle.ts), `health`, `discoverDaemon`, `statusDaemon`, and `ensureDaemon`.

Discovery collapses absent, unreadable, and malformed records into null; health collapses network denial, refusal, timeout, HTTP failure, and identity mismatch into false. Status therefore reports `running: false` when it cannot determine reachability. Token inspection likewise conflates missing, unreadable, unsafe permissions, and invalid contents. Detached daemon stdout/stderr are discarded, and its exit status is not reported while startup waits for health.

The earlier live probe demonstrated a healthy daemon outside the sandbox and a failed socket connection inside it. The lock fix now exposes the subsequent `EPERM`, but does not yet expose that preceding network failure.

Fix: distinguish absent/stopped from unreachable/invalid discovery, retain safe transport diagnostics, and expose bounded startup failure details and child exit status. A startup failure should not require guessing from a timeout.

### 3. HTTP and CLI translation discard diagnostic identity

Source: [server.ts](../src/server/server.ts), `controlError`; [lifecycle.ts](../src/server/lifecycle.ts), `controlRequest`; [main.ts](../src/cli/main.ts), `failure`.

The server maps ENOENT, EPERM/EACCES, EEXIST, and storage errors to useful application codes but drops their original codes, messages, syscall, and paths. Unexpected exceptions become a generic internal error without a diagnostic reference. The transport client collapses fetch exceptions into `transport_unavailable` and body/parse failures into `invalid_response`, dropping the cause. The final envelope omits HTTP status, syscall, path, and nested `cause` unless explicitly copied into `details`.

A dependency-injected CLI probe preserved `EPERM` and its message but discarded the supplied syscall, path, and nested diagnostic. Application codes can remain stable while structured details retain safe underlying causes.

Fix: use one bounded diagnostic representation across layers: application code, underlying code, relevant syscall/path, HTTP or child exit status, operation stage, and known outcome. Do not blindly serialize error objects, headers, launch URLs, tokens, or arbitrary subprocess output.

### 4. Package input errors are mislabeled as invalid content

Source: [main.ts](../src/cli/main.ts), `folio.import`.

One catch wraps both bounded file reading and JSON parsing as `invalid_package`, replacing ENOENT, EPERM/EACCES, and `input_too_large`. Reproduced: a missing package returns `invalid_package`; ENOENT survives only as text in the message.

Fix: separate reading from parsing; preserve input-access and size errors, reserving `invalid_package` for invalid package content.

### 5. Multi-step commands omit completed work when a later step fails

Source: [main.ts](../src/cli/main.ts), `setup`, `open`, `uninstall`, and `update`; [io.ts](../src/cli/io.ts), `writeExport`.

Setup can save preferences, install a skill/widget, seed a document, and register it before opening fails; it then returns the nested `open` failure without the completed setup results. Open can create daemon/registry state before host placement fails, but its failure does not describe that state. Uninstall performs sequential removals with no partial-completion response. Export can publish the destination before directory sync fails, yet returns only the filesystem exception. Update includes backup/log text but omits the child exit status as a structured field.

Fix: report completed stages and whether the requested effect is applied, partially applied, not applied, or unknown. Do not infer rollback from an error. These cases were established by control-flow inspection, not fault-injected live installation changes.

### 6. Saved host preference failures silently select another behavior

Source: [setup.ts](../src/cli/setup.ts), `readHostPreference`.

Every read/parse/validation error defaults to `auto`, including denied access and corrupt configuration. A caller can therefore use a different host without learning why its saved preference was ignored.

Fix: default only when the preference file is absent; report other failures, or expose an explicit warning with the fallback decision.

## Behavior already preserving information

- Argument parsing rejects unknown/duplicate flags and missing required values; file/stdin input is bounded, and review/document data generally passes through the HTTP client without truncation by the CLI.
- Successful response shape checks and explicit pagination/continuations prevent several kinds of silent incomplete reads.
- Mutation transport errors already carry conservative outcome/recovery guidance, and review operation IDs support receipt lookup.
- Folio host-sync failure is returned as `hostSyncStatus: failed` plus `hostIssue`; package import reports per-item results and partial outcomes. These may have `ok: true` and exit 0 because the envelope represents successful execution of a batch/reporting operation: agents must inspect the result fields. This is not swallowed output, but should be made explicit in the agent-facing contract.
- Cleanup catches that keep an earlier primary error intact, and catches that isolate dead UI subscribers, should not indiscriminately become command failures.

## Verification and next boundary

The previous startup fix passed 290 tests, TypeScript, and the browser build. This audit added direct missing-package and injected-error probes, plus an isolated daemon registration probe; it did not modify the live document registry during those probes. Configuration changes approved separately were applied to `~/.zshrc` and `~/.codex/config.toml`, with zsh syntax and TOML parsing checks passing. Fresh-session sandbox verification and Tether setup permission work remain deferred as requested.
