# Tether for Paseo

A [Paseo](https://paseo.sh) plugin that puts Tether's Folio in Paseo's Explorer sidebar and opens Tether readers in Paseo browser tabs. See [host setup](../../docs/guide/hosts.md#paseo-experimental) for installation and use.

## How it works

Paseo's **Settings → Appearance** includes **Tether Light**, **Tether Dark**, **Light Treason**, and **Dark Academia**, in the same order as Tether's theme menu. At the top of a Paseo reader’s theme picker, **Inherit Paseo theme** makes readers and Folio follow matching Paseo palettes. All seven bundled Paseo palettes and the four Tether contributions have matches; an unknown palette keeps the last theme. Choosing a named theme turns inheritance off. This preference belongs to the Paseo client and leaves other hosts unchanged. Detection runs while a desktop Folio panel is mounted, using Paseo’s supplied theme colors; the current palette is synchronized before Folio loads. Tether retains its reading fonts.

On desktop, the Explorer panel embeds Tether's existing web Folio, with its filters, saved chips, menus, sorting, archive, settings, and theme. Web/mobile clients and failed desktop loads show the native document list; failed loads offer **Retry full Folio**. Readers and the embedded Folio require the Paseo desktop app, Paseo daemon, and Tether to run on the same computer.

Embedding is experimental: Paseo has no supported plugin webview API. The isolated `client/web-folio.ts` adapter uses the desktop browser partition admitted by Paseo 0.9.2. It retains Paseo's sandbox and cookie handling without injecting scripts or accessing browser credentials. A future Paseo release may block embedding; the native list remains available. See the [Paseo plugin contract](https://paseo.sh/docs/plugins/reference) and [upstream webview proposal](https://github.com/getpaseo/paseo/issues/3548).

Nothing outside Paseo can open its tabs, so the plugin pulls opens from Tether:

- **Links inside a reader** don't involve the plugin. The reader opens the linked document itself as a new tab (through its session's `api/link` route). Paseo puts page-opened tabs in the focused pane, so focus mode is unaffected.
- **Folio clicks** are queued in Tether's daemon as *intents*, and the plugin opens them.
- **An agent's `tether open` or `tether recents add`** in a Paseo workspace becomes an *announcement*: the workspace's Tether button shows the document's name until it's opened.

- `index.server.ts` (in the Paseo daemon's plugin process) runs one `Hub` (`server/hub.ts`). The hub long-polls `tether paseo wait` through the Tether CLI (`server/tether-cli.ts`), keeps Folio current, and hands each reader intent to exactly one desktop client. Agent announcements become per-workspace notices, which clear once the document is opened. The server also adds `TETHER_PASEO_WORKSPACE_ID` to each agent's environment when its session opens.
- `index.client.tsx` (in the app) runs one pump (`client/pump.ts`), which mirrors the hub into a shared store (`client/state.ts`) for the native list and header buttons. Folio panels (`client/folio-panel.tsx`) lend Paseo's `openBrowser` while mounted, including during loading and fallback. That handle is available only to mounted panels, so every tab opens through the oldest mounted Folio. With none mounted, the pump reveals the intent's Folio first. The header button (`client/header-buttons.ts`) never opens anything on its own.
- The `tether.folio-view` RPC runs `tether folio --url --host paseo`, bound to the panel's workspace and current connection settings. Each client caches only successful final Folio URLs by host, Tether command, profile, and workspace; one-use tickets are never shared or cached. A failed cached session gets one fresh launch before falling back. The web Folio receives updates through Tether's own SSE connection and opens documents through the existing intent queue.

The Tether side lives in `src/hosts/paseo.ts` and `src/hosts/pull-queue.ts`, with the `/control/hosts/paseo/*` routes in `src/server/server.ts`.

## Development

```sh
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload tether   # after changes; the app's own reload doesn't rebuild directory plugins
paseo plugin logs tether
```

Tests run from the repository root with `bun test tests/paseo-*.test.ts`. They cover the hub, the client handoff, and the hub against a real Tether daemon.
