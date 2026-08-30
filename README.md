# Tether

Tether is a local Markdown review environment for human–agent dialogue. It combines a visual editor with durable, document-embedded review threads and host-neutral agent tooling.

The first implementation is being extracted from a working Wave Terminal viewer. Wave remains one adapter; the core document and review model does not depend on it.

## Current scope

Phase 2 adds the standalone loopback daemon, scoped browser sessions, the extracted Milkdown editor, document and review transactions, Recents and preferences, lifecycle discovery, and the system-browser CLI. The existing `wave-annotations:v1` envelope remains byte-compatible during the rollback window.

## Source-checkout preview

Install dependencies, copy a Markdown file for preview use, and open it:

```sh
bun install
cp /path/to/source.md /tmp/tether-preview.md
TETHER_PROFILE=preview ./mdreview open /tmp/tether-preview.md
```

The command starts or reuses one per-profile daemon and opens the editor in the default browser. The file is the durable review store; Recents and theme preferences live in Tether's profile config. To inspect or stop the daemon:

```sh
TETHER_PROFILE=preview ./mdreview daemon status
TETHER_PROFILE=preview ./mdreview daemon stop
```

`TETHER_RUNTIME_DIR` and `TETHER_CONFIG_DIR` can set exact private directories for an isolated run. CLI stdout is one protocol-v1 JSON object. Exit code `0` is success, `1` is an operational failure, and `2` is invalid usage.

## Agent review CLI

Agent commands use the same daemon and serialized document service as the browser. Start with compact pending state, inspect individual threads, and request the full body only when needed:

```sh
TETHER_PROFILE=preview ./mdreview pending /tmp/tether-preview.md --actor codex
TETHER_PROFILE=preview ./mdreview thread /tmp/tether-preview.md <thread-id>
TETHER_PROFILE=preview ./mdreview document read /tmp/tether-preview.md
```

Reply or change thread state:

```sh
TETHER_PROFILE=preview ./mdreview reply /tmp/tether-preview.md <thread-id> --actor codex --body-file -
TETHER_PROFILE=preview ./mdreview resolve /tmp/tether-preview.md <thread-id> --actor codex
TETHER_PROFILE=preview ./mdreview reopen /tmp/tether-preview.md <thread-id> --actor codex
TETHER_PROFILE=preview ./mdreview acknowledge /tmp/tether-preview.md --actor codex --through <seq> --body-revision <revision>
```

Conflict-safe body saves require the revision returned by `document read` and accept a file or stdin:

```sh
TETHER_PROFILE=preview ./mdreview document save /tmp/tether-preview.md --expected-body-revision <revision> --body-file -
```

`pending` and `thread` avoid returning the full document. All commands emit one structured JSON response and never use Recents as file authority.

## Development

```sh
bun install
bun run check
bun run build:web
```

Tether is under active development. Keep the current Wave viewer as the daily-use fallback and do not edit one real file through both daemons at once.
