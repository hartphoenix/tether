# Tether

Tether is a local Markdown review environment for human–agent dialogue. It combines a visual editor with durable, document-embedded review threads and host-neutral agent tooling.

The first implementation is being extracted from a working Wave Terminal viewer. Wave remains one adapter; the core document and review model does not depend on it.

## Current scope

Tether is the active Markdown viewer and review system. Phase 3 provides Wave placement, hidden navigation, a scoped Recents page, three indexed recent-file launchers, and a credential-isolated bridge for wikilinks. The standalone daemon and editor remain host-neutral. The existing `wave-annotations:v1` envelope remains the current durable document format.

## Source-checkout preview

Install dependencies, copy a Markdown file for preview use, and open it:

```sh
bun install
cp /path/to/source.md /tmp/tether-preview.md
TETHER_PROFILE=preview ./mdreview open /tmp/tether-preview.md
```

The command starts or reuses one per-profile daemon and opens the editor in the default browser. Document-scoped browser sessions survive inactive or suspended webviews; heartbeat leases report presence but do not revoke access. The daemon remains idle while sessions exist and stops explicitly. The file is the durable review store; Recents and theme preferences live in Tether's profile config. To inspect or stop the daemon:

```sh
TETHER_PROFILE=preview ./mdreview daemon status
TETHER_PROFILE=preview ./mdreview daemon stop
```

## Wave installation

Install or refresh the four canonical Tether launchers. This atomically removes retired legacy, preview, and duplicate widget definitions while preserving unrelated widgets:

```sh
./mdreview wave status
./mdreview wave install
```

The launchers use the established `TETHER_PROFILE=preview` data profile for continuity: Tether Recents and recent positions 1–3. They launch a short-lived command block, then place the Recents page or editor in a hidden-navigation web block. Remove the Tether launchers with:

```sh
./mdreview wave uninstall
```

Record a document without opening it and synchronize the active host's recent launchers with:

```sh
TETHER_PROFILE=preview ./mdreview recents add /absolute/path/to/document.md
```

The installer preserves unrelated Wave widgets and creates a one-time `widgets.json.tether-cutover.backup`. Wave's native file navigator remains outside Tether because Wave 0.14.5 has no public file-extension routing hook.

`TETHER_RUNTIME_DIR` and `TETHER_CONFIG_DIR` can set exact private directories for an isolated run. CLI stdout is one protocol-v1 JSON object. Exit code `0` is success, `1` is an operational failure, and `2` is invalid usage.

## cmux integration

Tether currently gates cmux support to the exact verified build `0.64.22 (102) [ddd4a01bc]`. From a cmux terminal, opening a document creates or reuses one Tether review pane beside the invoking surface; later documents become tabs in that pane:

```sh
TETHER_PROFILE=preview ./mdreview open /absolute/path/to/document.md
TETHER_PROFILE=preview ./mdreview open /absolute/path/to/document.md --no-focus
```

Open Tether Recents in cmux's right-sidebar Dock with:

```sh
TETHER_PROFILE=preview ./mdreview recents
```

The Dock beta feature must be enabled in cmux. Tether reports `dock_unavailable` when it is disabled and never substitutes the system browser for requested cmux placement. Check direct and daemon-callback readiness independently:

```sh
TETHER_PROFILE=preview ./mdreview cmux status
```

Daemon callbacks use cmux's signed terminal capability through a narrow Tether bridge. The capability remains only in bridge process memory; it is not stored in launch targets, discovery records, logs, URLs, or documents.

## Agent review CLI

Agent commands use the same daemon and serialized document service as the browser. Start with compact pending state, inspect individual threads, and request the full body only when needed:

```sh
TETHER_PROFILE=preview ./mdreview pending /tmp/tether-preview.md --actor assistant
TETHER_PROFILE=preview ./mdreview thread /tmp/tether-preview.md <thread-id>
TETHER_PROFILE=preview ./mdreview document read /tmp/tether-preview.md
```

Reply or change thread state:

```sh
TETHER_PROFILE=preview ./mdreview reply /tmp/tether-preview.md <thread-id> --actor assistant --body-file -
TETHER_PROFILE=preview ./mdreview resolve /tmp/tether-preview.md <thread-id> --actor assistant
TETHER_PROFILE=preview ./mdreview reopen /tmp/tether-preview.md <thread-id> --actor assistant
TETHER_PROFILE=preview ./mdreview acknowledge /tmp/tether-preview.md --actor assistant --through <seq> --body-revision <revision>
```

Conflict-safe body saves require the revision returned by `document read` and accept a file or stdin:

```sh
TETHER_PROFILE=preview ./mdreview document save /tmp/tether-preview.md --expected-body-revision <revision> --body-file -
```

`pending` returns only unacknowledged event deltas; use `thread` to fetch full thread state. Neither command returns the full document. All commands emit one structured JSON response and never use Recents as file authority.

## Development

```sh
bun install
bun run check
bun run build:web
```

Tether is under active development. The legacy Roger viewer and queue are archived and no longer form part of the operating system.
