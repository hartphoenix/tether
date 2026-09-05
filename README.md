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
<!-- wave-annotations:v1
{"type":"ledger","documentId":"c7f813ef-d6e3-46ce-8ead-20fef8d63450","baseBodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8","createdAt":"2026-09-03T21:12:34.013Z"}
{"type":"comment","id":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7","seq":1,"actor":"hart","createdAt":"2026-09-03T21:12:34.013Z","anchor":{"exact":"durable","prefix":". The existing wave-annotations:v1 envelope remains the current ","suffix":" document format.\nSource-checkout preview\nInstall dependencies, ","projectionStart":697,"projectionEnd":704,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-27995874-b883-4f39-b310-1a96befc7259","seq":2,"actor":"hart","createdAt":"2026-09-03T21:12:45.162Z","targetId":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7","threadId":"a-8c6fddc3-ef5e-43b2-806e-0427157755f7"}
{"type":"comment","id":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7","seq":3,"actor":"hart","createdAt":"2026-09-03T21:13:03.214Z","anchor":{"exact":"bun install","prefix":"ependencies, copy a Markdown file for preview use, and open it:\n","suffix":"\ncp /path/to/source.md /tmp/tether-preview.md\nTETHER_PROFILE=pre","projectionStart":819,"projectionEnd":830,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-bac321d0-241d-420c-8fc6-f308fed4e0f0","seq":4,"actor":"hart","createdAt":"2026-09-03T21:13:09.350Z","targetId":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7","threadId":"a-8aed0b6c-5e2c-4079-b6b0-1391530391d7"}
{"type":"comment","id":"a-93263ea8-7925-4e0e-9152-8965e5ad7531","seq":5,"actor":"hart","createdAt":"2026-09-03T21:25:19.368Z","anchor":{"exact":"wave","prefix":"preserving unrelated widgets:\n./mdreview wave status\n./mdreview ","suffix":" install\nThe launchers use the established TETHER_PROFILE=previe","projectionStart":1686,"projectionEnd":1690,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"comment","id":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229","seq":6,"actor":"hart","createdAt":"2026-09-03T21:26:09.363Z","anchor":{"exact":"preview","prefix":"ether Recents in cmux's right-sidebar Dock with:\nTETHER_PROFILE=","suffix":" ./mdreview recents\nThe Dock beta feature must be enabled in cmu","projectionStart":3086,"projectionEnd":3093,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"‘nother test comment"}
{"type":"comment","id":"a-02b6f07b-a44b-4630-bd0f-308c42a37318","seq":7,"actor":"hart","createdAt":"2026-09-03T21:26:16.604Z","anchor":{"exact":"preview","prefix":"ect and daemon-callback readiness independently:\nTETHER_PROFILE=","suffix":" ./mdreview cmux status\nDaemon callbacks use cmux's signed termi","projectionStart":3356,"projectionEnd":3363,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"third test comment"}
{"type":"delete","id":"a-62c52b87-8ac4-4c33-b9e8-812591d0d8d7","seq":8,"actor":"hart","createdAt":"2026-09-03T21:26:57.132Z","targetId":"a-93263ea8-7925-4e0e-9152-8965e5ad7531","threadId":"a-93263ea8-7925-4e0e-9152-8965e5ad7531"}
{"type":"delete","id":"a-7aa2121c-4ed6-473f-b45a-c720c63770cf","seq":9,"actor":"hart","createdAt":"2026-09-03T21:26:59.686Z","targetId":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229","threadId":"a-854a5f4f-fb73-4f51-86a1-9e5918c93229"}
{"type":"delete","id":"a-182a6fe2-f6aa-4c3e-814c-4a8869970768","seq":10,"actor":"hart","createdAt":"2026-09-03T21:27:02.458Z","targetId":"a-02b6f07b-a44b-4630-bd0f-308c42a37318","threadId":"a-02b6f07b-a44b-4630-bd0f-308c42a37318"}
{"type":"comment","id":"a-982f54b2-f390-4524-ac1e-904372bd7ba1","seq":11,"actor":"hart","createdAt":"2026-09-03T21:35:53.106Z","anchor":{"exact":"placement","prefix":"active Markdown viewer and review system. Phase 3 provides Wave ","suffix":", hidden navigation, a scoped Recents page, three indexed recent","projectionStart":443,"projectionEnd":452,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-6975da49-ba04-430b-a44d-2cff9f21bcef","seq":12,"actor":"hart","createdAt":"2026-09-03T21:36:02.383Z","targetId":"a-982f54b2-f390-4524-ac1e-904372bd7ba1","threadId":"a-982f54b2-f390-4524-ac1e-904372bd7ba1"}
{"type":"comment","id":"a-9976bc9f-608e-4142-997f-3454144c7769","seq":13,"actor":"hart","createdAt":"2026-09-03T21:36:26.440Z","anchor":{"exact":"visual","prefix":"down review environment for human–agent dialogue. It combines a ","suffix":" editor with durable, document-embedded review threads and host-","projectionStart":93,"projectionEnd":99,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test"}
{"type":"delete","id":"a-03736d2f-9329-4061-b5fe-237e30cc53fb","seq":14,"actor":"hart","createdAt":"2026-09-03T21:36:31.378Z","targetId":"a-9976bc9f-608e-4142-997f-3454144c7769","threadId":"a-9976bc9f-608e-4142-997f-3454144c7769"}
{"type":"comment","id":"a-34500b7f-e510-4b46-88a9-c9225521bceb","seq":15,"actor":"hart","createdAt":"2026-09-03T21:58:52.974Z","anchor":{"exact":"threads","prefix":"combines a visual editor with durable, document-embedded review ","suffix":" and host-neutral agent tooling.\nThe first implementation is bei","projectionStart":146,"projectionEnd":153,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment"}
{"type":"delete","id":"a-3c3e96cf-99af-4c9a-9791-61c65583e084","seq":16,"actor":"hart","createdAt":"2026-09-03T21:58:56.952Z","targetId":"a-34500b7f-e510-4b46-88a9-c9225521bceb","threadId":"a-34500b7f-e510-4b46-88a9-c9225521bceb"}
{"type":"comment","id":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5","seq":17,"actor":"hart","createdAt":"2026-09-03T21:59:24.818Z","anchor":{"exact":"threads","prefix":"combines a visual editor with durable, document-embedded review ","suffix":" and host-neutral agent tooling.\nThe first implementation is bei","projectionStart":146,"projectionEnd":153,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"comment"}
{"type":"delete","id":"a-f1616d1d-a758-4e5f-b700-eb6f30229dfc","seq":18,"actor":"hart","createdAt":"2026-09-03T21:59:27.993Z","targetId":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5","threadId":"a-6ae10d88-354e-45b5-9f49-c8054a02aeb5"}
{"type":"comment","id":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34","seq":19,"actor":"hart","createdAt":"2026-09-03T22:03:24.349Z","anchor":{"exact":"combines","prefix":" local Markdown review environment for human–agent dialogue. It ","suffix":" a visual editor with durable, document-embedded review threads ","projectionStart":82,"projectionEnd":90,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"this is a test comment, reply to say hi to aaron"}
{"type":"reply","id":"a-efd62e5f-9e75-46ea-8075-668a2376c938","seq":20,"actor":"assistant","createdAt":"2026-09-03T22:05:48.433Z","threadId":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34","body":"Hi, Aaron.\n"}
{"type":"ack","id":"a-f7d2599e-c8d0-4e56-ae22-19ba66101d19","seq":21,"actor":"assistant","throughSeq":19,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8","createdAt":"2026-09-03T22:05:56.327Z"}
{"type":"resolve","id":"a-1b6c0912-c9df-4aee-852d-0c38844c7e3d","seq":22,"actor":"hart","createdAt":"2026-09-03T22:06:21.279Z","threadId":"a-bd6d2aae-0881-41be-986a-5b4cceae3b34"}
{"type":"comment","id":"a-56027870-b8e7-4f42-b21f-f711fb7431a3","seq":23,"actor":"hart","createdAt":"2026-09-05T00:03:16.723Z","anchor":{"exact":"Markdown","prefix":"Tether\nTether is a local ","suffix":" review environment for human–agent dialogue. It combines a visu","projectionStart":25,"projectionEnd":33,"bodyRevision":"sha256:e416cf1b53447445f01662bba84bc2efdd9aebf063670c80dbbc41d2457f6ea8"},"body":"test comment for checking out ui zoom behavior"}
-->