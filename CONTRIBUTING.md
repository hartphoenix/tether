# Contributing to Tether

Read the [README](README.md) to get a feel for Tether, and use the [documentation map](docs/README.md) to find user and agent workflows. In your contribution, explain the problem, what changes for the user, and how you checked it.

## Run from source

Use macOS and Bun 1.3.9 to match CI and the bundled runtime license notice. From the checkout, run each command separately:

```sh
bun install --frozen-lockfile
cp /path/to/document.md /tmp/tether-example.md
TETHER_PROFILE=development ./tether open /tmp/tether-example.md --host browser
```

Keep the `TETHER_PROFILE=development` prefix on later CLI calls. It gives your development work separate private state, but still edits the Markdown files you point it to. Use a disposable copy. `./tether` and `./mdreview` use the same service. Stop it with `TETHER_PROFILE=development ./tether daemon stop`.

## Check a change

```sh
bun run check
```

This runs unit and integration tests, TypeScript checking, and the browser build. The tests need temporary loopback ports. If you change editor geometry, also run `bun run check:geometry`. Check native host behavior in the host you changed.

The [architecture guide](docs/contributing/architecture.md) explains the code boundaries; [package verification](docs/contributing/packages.md) covers installation and runtime checks. The GitHub workflow runs the full check plus package and installer checks on macOS.

## Submit a contribution

Keep changes focused and preserve unrelated work. List the commands you tested and any behavior you still need to check in a native host. Open an issue before introducing a new terminal host, major dependency, or public extension API.

For a bug report, include your Tether and macOS versions, CPU architecture, and host or browser version. Describe how to reproduce it, what you expected, and what happened. Leave out private documents, conversations, and credentials.

To add Linux or Windows support, provide a way to build Tether, implement file access, opening, and pickers for that platform, and test on the actual OS before advertising support.

Keep personal plans, session records, audits, and publisher operations under ignored `.local/`. Public docs should help people use Tether or contribute to it; development history stays local.
