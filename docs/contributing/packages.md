# Package verification

[Contributor setup](../../CONTRIBUTING.md)

Use these checks when you change installation, updates, or bundled assets. They build and exercise local candidates. Publishing a release requires separate authorization from the maintainer.

## Build and exercise a candidate

From the repository root, run each command separately:

```sh
bun run check
bun scripts/build-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-release.ts /absolute/path/to/new-candidate/app
bun scripts/check-install.ts /absolute/path/to/new-candidate/tether-darwin-arm64.tar.gz
```

Use `x64` instead of `arm64` for an Intel build. The builder uses the local Mac's architecture and installed Bun. Match the CI runtime in [CONTRIBUTING.md](../../CONTRIBUTING.md); the corresponding Bun license must exist in `licenses/`.

The builder won't overwrite an existing destination or archive. In the candidate directory, it writes the app, an archive for the build architecture, a SHA-256 checksum file, and a bootstrap installer pinned to that version. After the destination, its optional second argument sets the version; its optional third argument names a directory containing public `update-root.json` and `update-trust.json` files. Never put private publisher material in a candidate.

The app includes Bun, the CLI, daemon and host bridges, web assets, the welcome guide, the optional review skill, and license notices. Users don't need to build anything during installation.

## What the checks establish

`check-release.ts` runs with an isolated profile and minimal PATH. It checks setup, skill installation, Folio, reader assets, private review, and backup/restore, then stops its test daemon and leaves its evidence directory available for inspection.

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
