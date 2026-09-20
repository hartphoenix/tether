# Release and recovery

Tether's macOS packaging is under validation. No public release is available yet. The source checkout remains the documented public start path until a candidate passes validation for its selected scope. Distribution is through GitHub; no App Store release is planned. Developer ID signing and notarization are optional investments. Test the actual downloaded artifact before claiming easy installation, and resolve any observed launch restriction before making that claim.

## Build and check a candidate

With Bun installed, from the repository root:

```sh
bun run check
bun run build:release
```

The build uses the local Mac's CPU architecture and installed Bun runtime. It creates a versioned directory under `dist/release`, a `tether-darwin-<architecture>.tar.gz` archive, and its SHA-256 sidecar. Existing candidates are never overwritten; pass a fresh directory to `bun scripts/build-release.ts /absolute/path/to/candidate` for another build. Only publish architectures tested on actual Macs.

Run `bun scripts/check-release.ts /absolute/path/to/candidate` to exercise the packaged runtime from a temporary profile with a minimal PATH. It checks repeat setup, agent-skill installation, Folio, reader assets, private review, and backup/restore. It leaves its temporary evidence directory and stops its test daemon. This does not substitute for Safari/Wave/cmux interaction tests or a fresh account.

Run `bun scripts/check-install.ts /absolute/path/to/release.tar.gz` to test checksum refusal, repeated installation, paths with spaces, optional Wave setup, and uninstall while preserving private data and unrelated widgets. The macOS CI workflow runs both scripts; it does not sign or publish releases.

The package includes the Bun runtime, bundled CLI/daemon/host bridges, browser assets, welcome document, and review skill. No build occurs on the user's machine. Dependency/font licenses are copied into `licenses`; audit the packaged runtime's licensing notices and the final visual assets before publishing.

## Installer

First installation currently requires an archive and independently authenticated digest, supplied explicitly:

```sh
bash scripts/install.sh --archive /absolute/path/to/tether-darwin-arm64.tar.gz --sha256 <authenticated-hash> --no-open
```





Default locations are `~/.local/share/tether` for versioned releases and `~/.local/bin` for commands. `TETHER_INSTALL_DIR` and `TETHER_BIN_DIR` accept absolute alternatives. The installer preserves unrelated commands and shell profiles, prints a PATH instruction when needed, and invokes setup through its absolute path. It retains temporary download evidence and older release directories for recovery.

`tether setup --host browser` selects browser use. `--host auto` follows the invoking terminal. `--wave` explicitly installs Tether widgets. `--agent-directory /absolute/path/to/skills` installs the shared review skill into that chosen directory without replacing different existing instructions. These options are noninteractive and can be used by an agent. A plain setup seeds the welcome document and opens it; it does not automatically modify agent or host configuration.

For agent use, run `tether setup --agent-directory /absolute/path/to/skills --no-open` to install the editing, review, and Recents skill, including its guidance for plain-language reporting. Repeat this step after updating Tether to check the installed copy. If setup reports a differing skill, review the bundled `integrations/agents/tether-review/SKILL.md` against the installed file before approving replacement, preserving any local guidance; release updates do not refresh that copy automatically.

## Update and uninstall



Reader and Folio notices offer Install, Release Notes, and Dismiss. Dismissal persists per profile/version. Installation drains in-flight requests, stops the daemon, backs up private state, refreshes signed metadata, verifies the pinned candidate, installs, and starts the selected runtime. The initiating reader first waits for its recovery draft to persist; failure prevents installation. Readers keep their mounted editors through reconnection and are not automatically reloaded. Other views' unsent edits remain in their mounted pages; save work before quitting a host. Folio reloads after success. A failed new-runtime startup never automatically falls back to an older database runtime.





For a terminal update, save edits and quit Tether first. A normal service restart uses the current executable; it is not a software update.

```sh
tether daemon stop
tether update
tether
```

Update first creates a private-state backup beside the configuration directory, then runs the same installer. An interrupted download/check fails before switching the active installation. If an upgrade fails, keep its backup and old release files. Never run an older executable against a database that a newer release has upgraded without a tested compatibility/restore path.

`tether uninstall --confirm` removes the managed CLI symlinks and installed Tether Wave widgets, and moves the current-release pointer aside. It retains the versioned releases, agent skill, Markdown, and private data. Reinstall to restore launchers. It refuses to remove commands whose targets have changed.

## Full private-state backup

`.tether` export shares current open conversations; it omits resolved history and recovery state. For a full private-state backup:

```sh
tether daemon stop
tether backup --output /absolute/path/to/new-backup-directory
```

Backup holds the startup lock, refuses a running daemon, makes a consistent SQLite snapshot, and includes preferences, launch preferences, the legacy Recents index if present, and application-owned welcome documents. A checksum manifest is written last so an interrupted copy cannot masquerade as a complete backup. Treat this directory as private: it contains conversation history and drafts. Back up your ordinary Markdown files separately.

Restore into a new directory; it never overwrites existing state:

```sh
tether restore --source /absolute/path/to/backup --directory /absolute/path/to/restored-config
TETHER_CONFIG_DIR=/absolute/path/to/restored-config TETHER_RUNTIME_DIR=/absolute/path/to/new-runtime tether
```

Use a new runtime directory to keep recovery isolated. Existing document paths still refer to their original Markdown files; use Folio's Locate action for files that moved. Inspect the recovered data before making it your default configuration. Restore preserves history and recovery records; it does not reopen a lost browser's private cookies.

## Release validation and optional work

The Todoist `tether` project orders core review, installation/recovery validation, and publication before optional work. Validate fresh-account installation, the browsers/hosts actually advertised, and sleep/reboot recovery; publish the tested support matrix and known limitations. Automated verification may be completed by an agent with evidence, while live walkthroughs and final publication approval remain separate.

Logo/banner polish, additional host coverage, recruited user research, Developer ID signing/notarization, and a private vulnerability-reporting route are optional. Do not promise an untested installation experience or a reporting channel that does not exist. Keep unpublished capabilities and untested environments explicit in README.
