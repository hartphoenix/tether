# Contributing to Tether

Tether runs on macOS using Bun and TypeScript. Read README for the product flow and `docs/product-plan.md` for release scope.

Run `bun install`, then `bun run check` before submitting a change. The full check runs unit/integration tests, TypeScript checking, and the browser build. Some tests need temporary loopback ports. See `docs/release.md` to build and exercise a packaged candidate.

Keep document/review logic independent of terminal hosts. Wave, cmux, and browsers report their capabilities through adapters. Comments belong in private SQLite, not Markdown. Preserve conflict checks, document-scoped access, and the separation between acknowledgement and resolution.

For a bug report, include the Tether version, macOS version, CPU architecture, host/browser version, minimal reproduction, and expected/observed behavior.

Linux and Windows version contributions are welcome. Provide a build path, platform-specific file/open/picker behavior, and tests performed on the actual OS.

Prefer focused changes with a concrete before/after description and relevant verification. Open an issue before introducing a new terminal host, major dependency, or public extension API.
