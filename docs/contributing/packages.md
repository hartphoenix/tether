# Package verification

[Contributor setup](../../CONTRIBUTING.md)

Run these checks when you change installation, updates or bundled assets. They build and exercise local candidates without publishing anything; publishing a release requires separate authorization from the maintainer.

## Background service identity

Every Tether-owned service, helper, connector and background process must identify itself as Tether in macOS System Settings and Activity Monitor. Use `tether` as the service name and executable name, with a descriptive Tether-prefixed role where distinction is needed. Generic names such as `run` are not acceptable. The application identity must use the Tether logo and the publisher identity `hartphoenix`.

For macOS distribution, package services in an application bundle with the correct display name, bundle identifier and icon. Register embedded agents through `SMAppService`; do not install new plists in `~/Library/LaunchAgents` or rely on `AssociatedBundleIdentifiers` for ad-hoc app attribution. A stable per-profile native service app owns the registration and executes the current release runtime. Sign with the authorized Apple Developer ID identity: publisher text, copyright fields and Tether's update signatures do not establish macOS developer attribution. Do not relabel a third-party runtime's signature as Tether's or claim verified `hartphoenix` attribution before Apple recognizes the signing identity.

Verify the installed name, logo and developer attribution in System Settings, and the identity of the service and its children in Activity Monitor. Cover initial install, updates, restart and uninstall, preserving the user's background-item permissions. Do not reset the global macOS background-item database to remove stale entries. Local source bundles and release candidates use an ad-hoc signature with no verified developer identity; this is distinct from both Apple Developer ID signing and Tether update-metadata signing. They use the Tether name and icon, but must not claim the verified developer requirement is met. A newly identified app needs its own macOS file-access consent; ad-hoc rebuilds can require renewed consent. Never grant or bypass that consent programmatically. The runtime is copied into the bundle as `tether`, replacing its vendor signature with the local ad-hoc signature so Tether is not attributed to the runtime vendor. Installer upgrades migrate owned legacy registrations, preserving disabled legacy items until the user permits migration. Registration failures restore the old plist and reload a previously loaded job. macOS may retain an old background-item record; verify the current executable path rather than resetting unrelated records.

References: [Apple's helper migration requirements](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos), [managing background tasks](https://support.apple.com/guide/deployment/depdca572563/web).

## Build and exercise a candidate

From the repository root, run each command separately:

```sh
bun run check
bun scripts/build-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-startup.ts /absolute/path/to/new-candidate/app
bun scripts/check-install.ts /absolute/path/to/new-candidate/tether-darwin-arm64.tar.gz
```

For an Intel build, use `x64` in place of `arm64`. The builder uses the local Mac's architecture and installed Bun. Use the Bun version named in [CONTRIBUTING.md](../../CONTRIBUTING.md), which matches CI; its license must exist in `licenses/`.

The builder refuses to overwrite an existing destination or archive. In the candidate directory, it writes the app, an archive for the build architecture, a SHA-256 checksum file and a bootstrap installer pinned to that version. An optional second argument sets the version, and an optional third names a directory containing the public `update-root.json` and `update-trust.json` files. Never put private publisher material in a candidate.

The app includes Bun, the CLI, the daemon and host bridges, web assets, the welcome guide, the current release notes, both optional agent skills, the compiled Paseo plugin with its theme and attribution assets, and license notices. Users don't build anything during installation.

## What the checks establish

`check-release.ts` runs with an isolated profile and a minimal PATH. It checks the release notes, both skills, the compiled plugin's payload, themes and notices, the absence of personal workspace-migration code, setup, skill installation, Folio, reader assets, private review, and backup and restore. Afterward, it stops its test daemon and leaves its evidence directory for inspection.

`check-startup.ts` runs the packaged login entry with the environment the generated job gives launchd, in disposable directories. It verifies that the job follows `current`, that a second start reuses the running daemon, that SIGTERM stops it cleanly, that a crash does not block the next start, and that disable removes the job and hook. It mocks service registration and launchctl, executes the actual native launcher, and never registers a real login job.

`bun scripts/check-macos-service.ts <candidate/app> --register-test-service` requires a disposable macOS account named `tether-test`; the script refuses other accounts before creating files or registrations. Native registration tests must never run in a personal account: temporary profiles do not isolate the Background Items database or OS notifications. In that disposable account, the check creates a legacy job, migrates it through SMAppService, checks repeated setup, switches the release pointer, restarts the agent and exercises uninstall and source supervision. Also inspect System Settings there for one entry with the logo; API status alone does not prove its appearance. Normal automated tests mock registration and never add login items.

`check-paseo-package.ts <candidate-directory> <paseo-cli>` exercises the compiled plugin with Paseo 0.11.2 in a disposable home and daemon. It verifies directory registration, disabled-state preservation, runtime compilation/loading, following the current-release pointer, explicit reload, and removal. It does not verify desktop UI interactions.

`check-verified-update.ts <0.1.3-archive> <0.1.4-archive>` rehearses CLI, reader, and Folio updates from the published baseline using the supplied binaries. It replaces only their public trust files in disposable copies, signs those copies with ephemeral test keys, and verifies draft/review recovery and skill migration. The original archives and production publisher state are untouched.

`check-install.ts` checks that installation rejects a wrong checksum, works repeatedly and with paths containing spaces, sets up Wave widgets, and uninstalls without removing private data or unrelated widgets. [.github/workflows/check.yml](../../.github/workflows/check.yml) runs these checks on macOS without publishing.

These checks don't cover installation on a fresh account, interaction in native browsers and hosts, recovery after sleep or reboot, or launch behavior after downloading the package; test those by hand. Record the macOS version, architecture, browser or host version and results with your change, and advertise support only for combinations you have evidence for.

## Bootstrap and release boundaries

To combine separately tested archives, run this command in one go:

```sh
bun scripts/build-bootstrap.ts X.Y.Z /path/to/new-install.sh /path/to/arm64/tether-darwin-arm64.tar.gz /path/to/x64/tether-darwin-x64.tar.gz
```

The generator checks that versions and platforms match, computes the hashes, and refuses to overwrite an existing output. First installation trusts the official HTTPS distribution. Later package updates check signed metadata against the installed public trust material. See [installation](../guide/installation.md) for the user procedure.

A public release needs the exact archives and bootstrap you tested, public update trust material inside those archives, and a working signed metadata service. Passing the local checks does not verify those endpoints or publisher recovery. Keep publisher credentials, deployment state, approval records, and operational runbooks outside Git.

## Rehearse an update locally

From the source checkout, run:

```sh
bun scripts/rehearse-update.ts
```

This builds two disposable macOS packages, serves signed update metadata on loopback using test keys, and installs the first package into isolated directories. It prints a folder containing reader and Folio launchers, a walkthrough, and a stop command. Keep the process running while you try the update and skill-review choices. Your normal installation, profile, agent skills, and production publisher state stay separate.

For an automated browser check, use `bun scripts/rehearse-update.ts --verify` with Playwright's Chromium installed. It exercises the package update, preserves the sample review, checks all three skill decisions, and saves a screenshot and verification result. This rehearsal does not establish installation on a fresh account or the availability of public release endpoints.

## Clean-account recovery acceptance

Run this acceptance matrix when you change login startup (`lib/login.js`), the cmux shell hook or pane recovery. A local candidate is enough; you don't need to publish. Neither installation nor setup registers a login job.

Use a disposable macOS account, record the macOS and cmux versions, and keep login startup disabled on your main account. Set up saved documents, a persisted draft, a conflict, reading positions and Folio in several cmux workspaces. When judging results, distinguish persisted changes from keystrokes that were never saved before termination.

| Test | Required result |
| --- | --- |
| Fresh install, startup off, logout/reboot | No Tether login job; normal manual Folio/open and uninstall still work. |
| `resume --inspect`, stopped and running | Stopped inspection starts no process; running inspection navigates nothing. |
| Manual resume after restored layout | Eligible error panes recover with their saved state; mounted/dirty/loading/unrelated pages remain untouched; focus and layout stay fixed. Browser error pages on exact Tether routes reload once. |
| Startup enabled, generated hook sourced, logout/reboot (twice, including delayed cmux launch) | One daemon and one cmux bridge per profile; the old bridge exited; Folio document clicks work; restored panes reload with existing cookies and saved state; no duplicated panes or terminal commands. With browser-only restoration, opening one terminal tab reconnects. |
| Fast user switch and two profiles | No access to the other account/profile; switching back does not create duplicate processes. |
| Port occupied, missing cookies, deleted session | Only exact saved routes qualify; no new authorization from enumeration; report skipped/authorization-required cases. |
| Stop/Quit versus restart | Stop/Quit stops the daemon and both bridges; the next `tether`, hook, or login starts cleanly. Menu restart keeps a working bridge and stops a broken one. |
| cmux quit or relaunch mid-session | The bridge exits; the next cmux terminal attaches a new one without manual steps. |
| Wave quit or logout | The Wave bridge exits within about a minute; a widget click reconnects. |
| Crash or missing runtime | The failed start is not retried in a loop; the next login, hook, or `tether` command starts normally once the cause is fixed. Test only disposable state. |
| Shutdown during initialization | No late daemon, bridge, or successor. |
| Update, disable, uninstall | After an update, login starts the new release without re-enabling. Disable/uninstall leave no login job or hook and preserve private data. |

Native recovery is not established by unit tests or headless browser tests. Do not enable unattended use on a primary account until the login, error-page, shutdown, and crash cases pass. Local candidates without publisher trust material also do not establish authenticated public update behavior.
