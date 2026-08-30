# Tether

Tether is a local Markdown review environment for human–agent dialogue. It combines a visual editor with durable, document-embedded review threads and host-neutral agent tooling.

The first implementation is being extracted from a working Wave Terminal viewer. Wave remains one adapter; the core document and review model does not depend on it.

## Current scope

Phase 1 contains the portable annotation ledger, rendered-text projection, thread derivation, Markdown codec, and their tests. The existing `wave-annotations:v1` envelope is retained temporarily so the working viewer remains a valid rollback path during extraction.

## Development

```sh
bun install
bun run check
```

Tether is under active development and is not yet a replacement for the current Wave installation.
