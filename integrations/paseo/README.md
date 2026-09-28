# Tether for Paseo

A [Paseo](https://paseo.sh) plugin that puts Tether's Folio in Paseo's Explorer sidebar and opens Tether readers in Paseo browser tabs. See [host setup](../../docs/guide/hosts.md#paseo-experimental) for installation and use.

## How it works

Nothing outside Paseo can open its tabs, so the plugin pulls opens from Tether:

- **Links inside a reader** don't involve the plugin. The reader opens the linked document itself as a new tab (through its session's `api/link` route). Paseo puts page-opened tabs in the focused pane, so focus mode is unaffected.
- **Folio clicks** are queued in Tether's daemon as *intents*, and the plugin opens them.
- **An agent's `tether open` or `tether recents add`** in a Paseo workspace becomes an *announcement*: the workspace's Tether button shows the document's name until it's opened.

- `index.server.ts` (in the Paseo daemon's plugin process) runs one `Hub` (`server/hub.ts`). The hub long-polls `tether paseo wait` through the Tether CLI (`server/tether-cli.ts`), keeps Folio current, and hands each reader intent to exactly one desktop client. Agent announcements become per-workspace notices, which clear once the document is opened. The server also adds `TETHER_PASEO_WORKSPACE_ID` to each agent's environment when its session opens.
- `index.client.tsx` (in the app) runs one pump (`client/pump.ts`), which mirrors the hub into a shared store (`client/state.ts`). Folio panels (`client/folio-panel.tsx`) render that store, and while mounted they lend Paseo's `openBrowser`. That handle is available only to mounted panels, so every tab opens through the oldest mounted Folio. With none mounted, the pump reveals the intent's Folio first. The header button (`client/header-buttons.ts`) never opens anything on its own.

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
