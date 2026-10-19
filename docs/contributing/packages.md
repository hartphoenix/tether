# Package verification

[Contributor setup](../../CONTRIBUTING.md)

When you change installation, updates or bundled assets, build a local candidate and run the checks below. Publishing a release requires separate authorization from the maintainer.

## Build a candidate

The installer requires macOS 13 or newer. The builder compiles native helpers with Apple Command Line Tools and bundles the installed Bun runtime for the Mac's architecture. Use the Bun version specified in [CONTRIBUTING.md](../../CONTRIBUTING.md) and CI, with its license file in `licenses/`.

From the repository root, run each command separately:

```sh
bun run check
bun scripts/build-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-startup.ts /absolute/path/to/new-candidate/app
bun scripts/check-install.ts /absolute/path/to/new-candidate/tether-darwin-arm64.tar.gz
```

For an Intel build, replace `arm64` with `x64` in the archive path. Changing the filename does not cross-compile the package.

The builder creates the package directory, then writes an archive, SHA-256 checksum and version-pinned bootstrap installer beside it. It refuses to overwrite an existing package directory or archive. The optional second argument selects a version. The optional third argument names a directory containing the public `update-root.json` and `update-trust.json` files. Keep private signing material outside the candidate.

The package contains Bun, the CLI, the daemon, host bridges, web assets, the welcome guide, release notes, both optional agent skills, the compiled Paseo plugin and license notices. Users install the package without compiling source or installing Bun or npm dependencies. When they enable startup, Tether assembles a service app for their profile from the prebuilt native controller and icon, then signs that local bundle ad hoc with macOS `codesign`.

## Background services

Package Tether services, helpers and connectors with the Tether name and logo so users can identify them in System Settings and Activity Monitor. Use `tether` for the executable name. Add a Tether-prefixed role when users need to distinguish processes.

Tether registers agents embedded in the service app through `SMAppService`. The native launcher executes the runtime at the installation's `current` path, which lets later logins start the selected release. New registrations belong inside the app bundle rather than `~/Library/LaunchAgents`.

Current builds copy Bun into `tether.app` as `tether` and replace its vendor signature with a local ad-hoc signature. This provides bundle integrity without verified publisher attribution. Developer ID distribution would require an authorized Apple signing identity. Publisher text and Tether's signed update metadata cannot establish macOS developer attribution.

During a packaged upgrade, the installer finds matching legacy jobs for that installation and attempts to migrate them. The source installer migrates its matching job when invoked with `--supervise yes`. Both paths leave jobs marked disabled by `launchctl print-disabled` in place. Test System Settings denials separately because that launchctl check does not establish preservation of every background-item permission.

If registration fails after the old job has been stopped, Tether attempts to restore its plist and reload it. A recovery failure is reported to the caller. After migration or uninstall, inspect both the running processes and System Settings: macOS can retain a visible record after the job has been unregistered. Preserve unrelated registrations and permissions when investigating stale entries.

A new app identity can trigger a macOS prompt for access to protected folders. An ad-hoc rebuild can require renewed consent. Let the user grant that consent through macOS.

See Apple's [helper migration requirements](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos) and [background-task management guide](https://support.apple.com/guide/deployment/depdca572563/web).

## Automated checks

`check-release.ts` uses isolated home, configuration and runtime directories with a minimal PATH. It checks the bundled documentation, skills and Paseo plugin, then exercises setup, skill installation, Folio, reader assets, private review, backup and restore. It also rejects personal workspace-migration code in the plugin. The script stops its test daemon and retains its evidence directory.

`check-startup.ts` executes the native launcher and packaged login entry in disposable directories while mocking service registration and launchctl. It checks that the plist points at `current`, a second start reuses the daemon, SIGTERM stops it cleanly and a later start recovers from a crash. Its disable check verifies removal of the service bundle, embedded plist and shell hook. It does not switch release versions or remove a real launchd job.

`check-install.ts` tests checksum rejection, repeated installation, paths containing spaces, Wave widget setup and uninstall. It verifies that uninstall preserves private data and unrelated widgets.

[The macOS CI workflow](../../.github/workflows/check.yml) runs `bun run check`, builds a candidate, then runs `check-release.ts` and `check-install.ts`. It also installs the Paseo plugin's dependencies and checks its types. The standalone startup, native service, Paseo package and update-rehearsal checks require separate runs.

### Native service registration

Run registration tests only in a disposable macOS account. Temporary Tether profiles do not isolate the account's Background Items database or OS notifications.

```sh
bun scripts/check-macos-service.ts /absolute/path/to/candidate/app --register-test-service
```

The script requires the username `tether-test` and refuses other usernames before creating files or registrations. Create a disposable account for this purpose. The username check does not establish that an account is safe to discard.

The script creates a legacy profile job, migrates it through SMAppService and checks repeated setup. It then switches `current` between two copies of the same candidate, restarts the agent, exercises packaged uninstall and registers a source service. These checks leave source connectors, multiple profiles, cross-version updates and denied background permissions for separate testing.

Inspect System Settings for a single entry with the Tether logo, then verify the service's identity in Activity Monitor. API registration status does not establish the displayed name or icon. After cleanup and restart, check that the test entries are gone.

### Paseo package

`check-paseo-package.ts <candidate-directory> <paseo-cli>` requires Paseo 0.11.2. Using a disposable home and daemon, it checks directory registration, preservation of disabled plugins, runtime compilation and loading, updates through `current`, explicit reload and removal. Desktop interactions require separate testing.

### Verified updates

`check-verified-update.ts <0.1.3-archive> <0.1.4-archive>` accepts exactly those two package versions. It copies the supplied packages, replaces their public trust files with test trust material and serves signed update metadata on loopback using ephemeral keys. It then exercises updates through the CLI, reader and Folio, checking draft and review recovery, skill migration, backup and restore. The original archives and production publisher state remain unchanged.

This checks signed update metadata without applying Apple Developer ID signatures. Its fixed version requirements limit its use for testing later releases. The no-argument mode currently fails for the same missing release-note fixtures described below.

## Local update rehearsal

`scripts/rehearse-update.ts` currently cannot complete from this checkout. It builds versions `0.1.0` and `0.2.0`, but `build-release.ts` requires a corresponding `docs/releases/<version>.md` file, and neither file exists. Repair those fixtures before running the rehearsal:

```sh
bun scripts/rehearse-update.ts
```

After that repair, the script is intended to build two disposable packages, serve signed metadata on loopback with test keys and install the first package into isolated directories. It writes reader and Folio launchers, a walkthrough and a stop command to its output directory. Keep the process running while exercising updates and skill-review choices.

With Playwright's Chromium installed, `bun scripts/rehearse-update.ts --verify` runs the browser checks. The script checks the updated daemon, retained review and automatic skill update. It exercises acceptance and retention of customized instructions through the reader, then simulates an approved merge through the CLI. It saves a screenshot and verification result. Fresh-account installation and public release endpoints require separate checks.

## Recovery in a disposable account

Use this matrix when changing login startup, the cmux shell hook or pane recovery. A local candidate is sufficient. Fresh installation and ordinary setup leave login startup off. An installer upgrade can register replacements for existing legacy jobs, while `tether startup enable` explicitly registers startup.

Record the macOS version, architecture and host versions. In the disposable account, prepare saved documents, a persisted draft, a conflict, reading positions and Folio in several cmux workspaces. Distinguish saved state from keystrokes that had not been saved before termination. Keep the working startup configuration in your main account unchanged.

| Test | Required result |
| --- | --- |
| Install with startup off, then log out or reboot | No Tether login job starts. Manual Folio/open and uninstall still work. |
| Run `resume --inspect` with the daemon stopped and running | Inspection starts no process when stopped and navigates no views when running. |
| Resume after restoring the layout | Eligible error panes recover saved state. Mounted, dirty, loading and unrelated pages remain untouched. Focus and layout stay fixed. Browser recovery reloads only error pages at exact Tether routes. |
| Enable startup, source the hook, then log out or reboot twice | Each profile has a daemon and a cmux bridge. Old bridges exit, Folio links work and restored panes recover cookies and saved state without duplication. Repeat with delayed cmux launch. For browser-only restoration, opening a terminal reconnects the bridge. |
| Switch users and exercise two profiles | Accounts and profiles remain isolated. Switching back creates no duplicate processes. |
| Occupy the port, remove cookies or delete a session | Recovery reports skipped views or required authorization. Enumerating saved routes grants no new access. |
| Stop or quit, then restart | Stop/Quit stops the daemon and both bridges. The next CLI, hook or login starts cleanly. Menu restart preserves a working bridge and replaces a broken bridge. |
| Quit or relaunch cmux | Its bridge exits. The next cmux terminal attaches a new bridge. |
| Quit Wave or log out | Its bridge exits within about a minute. A widget click reconnects. |
| Crash the daemon or remove its runtime | Packaged login startup does not retry in a loop. After repair, the next login, hook or CLI call starts normally. |
| Shut down during initialization | No daemon, bridge or successor starts afterward. |
| Update, disable and uninstall | Login starts the new release without re-enabling startup. Disable and uninstall remove the job and hook while preserving private data. |

Also test sleep recovery, native browser and host interactions, and the first launch of a downloaded package. Record results before claiming support for a platform or host combination.

## Prepare a public release

To combine separately tested archives, run:

```sh
bun scripts/build-bootstrap.ts X.Y.Z /path/to/new-install.sh /path/to/arm64/tether-darwin-arm64.tar.gz /path/to/x64/tether-darwin-x64.tar.gz
```

The generator checks each archive's version, platform and architecture, computes its hash and writes the bootstrap installer. It refuses to overwrite an existing output. First installation obtains the package through the official HTTPS distribution. Later updates check signed metadata against the installed public trust material. See [installation](../guide/installation.md).

Before publishing, verify the exact archives and bootstrap, include public update trust material and confirm that the signed metadata service works. Local checks do not establish public endpoint availability or publisher recovery. Keep credentials, private signing state, approval records and operational runbooks outside Git.
