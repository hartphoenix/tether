# Package verification

[Contributor setup](../../CONTRIBUTING.md)

Use these checks when you change installation, updates, or bundled assets. They build and exercise local candidates. Publishing a release requires separate authorization from the maintainer.

## Build and exercise a candidate

From the repository root, run each command separately:

```sh
bun run check
bun scripts/build-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-startup.ts /absolute/path/to/new-candidate/app
bun scripts/check-install.ts /absolute/path/to/new-candidate/tether-darwin-arm64.tar.gz
```

Use `x64` instead of `arm64` for an Intel build. The builder uses the local Mac's architecture and installed Bun. Match the CI runtime in [CONTRIBUTING.md](../../CONTRIBUTING.md); the corresponding Bun license must exist in `licenses/`.

The builder won't overwrite an existing destination or archive. In the candidate directory, it writes the app, an archive for the build architecture, a SHA-256 checksum file, and a bootstrap installer pinned to that version. After the destination, its optional second argument sets the version; its optional third argument names a directory containing public `update-root.json` and `update-trust.json` files. Never put private publisher material in a candidate.

The app includes Bun, the CLI, daemon and host bridges, web assets, the welcome guide, the optional review skill, and license notices. Users don't need to build anything during installation.

## What the checks establish

`check-release.ts` runs with an isolated profile and minimal PATH. It checks setup, skill installation, Folio, reader assets, private review, and backup/restore, then stops its test daemon and leaves its evidence directory available for inspection.

`check-startup.ts` executes the packaged login guard in disposable directories, verifies clean shutdown and crash suppression across repeated invocations, and checks disable cleanup. It mocks launchctl and never registers a real login job.

`check-install.ts` checks that installation rejects a wrong checksum, works repeatedly and with paths containing spaces, sets up Wave widgets, and uninstalls without removing private data or unrelated widgets. [.github/workflows/check.yml](../../.github/workflows/check.yml) runs these checks on macOS without publishing.

You still need to test installation on a fresh account, interaction in native browsers and hosts, sleep/reboot recovery, and launch behavior after downloading the package. Record the macOS version, architecture, browser or host version, and results with your change. Advertise support only for combinations you have evidence for.

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

Test the existing package now for an installation baseline. Use a rebuilt local candidate for recovery acceptance; publishing is unnecessary. The new candidate adds `lib/login.js`, opt-in startup assets, startup controls, and pane recovery. Neither installation nor setup registers a login job.

Run this matrix in a disposable macOS account, recording macOS and cmux versions. Keep the main account's startup disabled. Use saved documents, a persisted draft, a conflict, reading positions, and Folio in multiple cmux workspaces. Distinguish persisted changes from keystrokes never saved before termination.

| Test | Required result |
| --- | --- |
| Fresh install, startup off, logout/reboot | No Tether login job; normal manual Folio/open and uninstall still work. |
| `resume --inspect`, stopped and running | Stopped inspection starts no process; running inspection navigates nothing. |
| Manual resume after restored layout | Eligible error panes recover with their saved state; mounted/dirty/loading/unrelated pages remain untouched; focus and layout stay fixed. Record native error pages that cannot be evaluated. |
| Startup enabled, generated hook sourced, logout/reboot | One daemon and one cmux bridge per profile; fresh host authority, existing cookies, saved state; no duplicated panes or terminal commands. Repeat with browser-only restoration and verify the documented limitation. |
| Fast user switch and two profiles | No access to the other account/profile; switching back does not create duplicate processes. |
| Port occupied, missing cookies, deleted session | Only exact saved routes qualify; no new authorization from enumeration; report skipped/authorization-required cases. |
| Stop/Quit versus restart | Stop/Quit remain stopped across shell and login; restart creates one successor and permits recovery in later daemon generations. |
| Crash or broken/missing pinned runtime | First attempt fails; a second shell/login does not retry it. Restore the package, inspect, explicitly re-enable. Test only disposable state. |
| Disable during startup/restart, or shutdown during initialization | No late daemon/bridge or successor; status accurately reports incomplete cleanup. |
| Update, disable, uninstall | Update suppresses pinned startup; re-enable uses current runtime. Disable/uninstall leave no runnable login job and preserve private data and unrelated shell assets. |

Native recovery is not established by unit tests or headless browser tests. Do not enable unattended use on a primary account until the login, error-page, shutdown, and crash cases pass. Local candidates without publisher trust material also do not establish authenticated public update behavior.
