# Tether for Paseo

A [Paseo](https://paseo.sh) plugin that puts Tether's Folio in Paseo's Explorer sidebar and opens Tether readers in Paseo browser tabs. See [host setup](../../docs/guide/hosts.md#paseo-experimental) for installation and use.

## How it works

Paseo's **Settings → Appearance** includes **Tether Light**, **Tether Dark**, **Light Treason**, and **Dark Academia**, in the same order as Tether's theme menu. At the top of a Paseo reader’s theme picker, **Inherit Paseo theme** makes readers and Folio follow matching Paseo palettes. All seven bundled Paseo palettes and the four Tether contributions have matches; an unknown palette keeps the last theme. Choosing a named theme turns inheritance off. This preference belongs to the Paseo client and leaves other hosts unchanged. Detection runs while a header button, Folio panel or settings surface is mounted, using Paseo’s supplied theme colors; the current palette is synchronized before Folio loads. Tether retains its reading fonts.

On desktop, the Explorer panel embeds Tether's existing web Folio, with its filters, saved chips, menus, sorting, archive, settings, and theme. Web/mobile clients and failed desktop loads show the native document list; failed loads offer **Retry full Folio**. In local mode, the app, daemon and Tether run on the same computer. Tether Fly connects a remote Paseo daemon to an explicitly selected shared hub; the Mac app signs in at that hub’s HTTPS origin. See [Fly setup](../../docs/guide/fly-setup.md).

Embedding is experimental: Paseo has no supported plugin webview API. The isolated `client/web-folio.ts` adapter uses the desktop browser partition admitted by Paseo 0.9.2. It retains Paseo's sandbox and cookie handling without injecting scripts or accessing browser credentials. A future Paseo release may block embedding; the native list remains available. See the [Paseo plugin contract](https://paseo.sh/docs/plugins/reference) and [upstream webview proposal](https://github.com/getpaseo/paseo/issues/3548).

Nothing outside Paseo can open its tabs, so the plugin pulls opens from Tether:

- **Links inside a reader** don't involve the plugin. The reader opens the linked document itself as a new tab (through its session's `api/link` route). Paseo puts page-opened tabs in the focused pane, so focus mode is unaffected.
- **Folio clicks** are queued in Tether's daemon as *intents*, and the plugin opens them.
- **An agent's `tether open` or `tether recents add`** in a Paseo workspace becomes an *announcement*: the workspace's Tether button shows the document's name until it's opened.

- `index.server.ts` (in the Paseo daemon's plugin process) runs one `Hub` (`server/hub.ts`). The hub long-polls `tether paseo wait` through the Tether CLI (`server/tether-cli.ts`), keeps Folio current, and hands each reader intent to exactly one desktop client. Agent announcements become per-workspace notices, which clear once the document is opened. The server also adds `TETHER_PASEO_WORKSPACE_ID` to each agent's environment when its session opens.
- `index.client.tsx` (in the app) runs one pump (`client/pump.ts`), which mirrors the hub into a shared store (`client/state.ts`) for the native list and header buttons. Folio panels (`client/folio-panel.tsx`) lend Paseo's `openBrowser` while mounted, including during loading and fallback. That handle is available only to mounted panels, so every tab opens through the oldest mounted Folio. With none mounted, the pump reveals the intent's Folio first. The header button (`client/header-buttons.ts`) never opens anything on its own.
- The `tether.folio-view` RPC runs `tether folio --url --host paseo`, bound to the panel's workspace and current connection settings. Each client caches only successful final Folio URLs by host, Tether command, profile, and workspace; one-use tickets are never shared or cached. A failed cached session gets one fresh launch before falling back. The web Folio receives updates through short snapshot requests and opens documents through the existing intent queue.

The Tether side lives in `src/hosts/paseo.ts` and `src/hosts/pull-queue.ts`, with the `/control/hosts/paseo/*` routes in `src/server/server.ts`.

## Connection and process limits

Changing the Tether command, profile, or shared connection replaces the plugin connection, clears its stale notices and pending launches, and rejects actions from the previous connection. Invalid settings stop plugin work until valid settings return. Existing reader tabs and their sessions remain open. Changing only header-button visibility does not reset the connection. After upgrading from an older plugin bundle, reload Paseo if a view asks to update.

CLI work has a 45-second total deadline, including queue time. One process slot is reserved for queue polling and three for other commands; at most 32 calls wait for a slot. Output is limited to 16 MiB of stdout and 64 KiB of stderr per command. Overflow fails explicitly. Timeout or connection cancellation stops the direct CLI child, with forced termination after 250 ms if needed; it does not stop the detached shared Tether daemon. A timed-out mutation may already have completed: check the result before repeating an open or pin action.

The child environment permits `HOME`, `USERPROFILE`, `PATH`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `TETHER_RUNTIME_DIR`, `TETHER_CONFIG_DIR` and `TETHER_INSTALL_ROOT`. The runner supplements PATH with common Bun/install locations and sets `TETHER_PROFILE` from validated plugin settings. Workspace and origin routing are supplied explicitly per command. Other inherited variables, including ambient host routing and credentials, are omitted. Custom executable wrappers must work within this environment; use the source or packaged launcher directly if a wrapper depends on other variables.

Client errors use fixed summaries and recognized error codes. Raw stderr and arbitrary child error messages are neither forwarded to clients nor written to a new diagnostic log. Check plugin settings and daemon status for startup failures.

## Development

```sh
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload tether   # after changes; the app's own reload doesn't rebuild directory plugins
paseo plugin logs tether
```

Tests run from the repository root with `bun test tests/paseo-*.test.ts`. They cover the hub, the client handoff, and the hub against a real Tether daemon.
