# Host setup

[Documentation](../README.md) · [Recovery](recovery.md)

"Host" here refers to your local terminal environment's embedded browser (such as cmux or wave, which Tether provides adapters for), not a cloud platform or remote server.

Run `tether setup --host auto` to use the supported terminal you’re working in, or `tether setup --host browser` to use a separate browser. You can select a terminal explicitly with `--host cmux` or `--host wave`. Inside Paseo, the Tether plugin selects the `paseo` host itself. Your local data is shared across hosts that use the same account and profile.

## cmux

cmux is the recommended host for Tether, providing the most flexibility. Its Dock (enabled through **cmux settings > Beta Features > Dock**) keeps the Folio handy with a hotkey (default `⌘-⌥-B`), letting you launch the reader into any workspace while keeping your screen uncluttered. Tether requires cmux 0.64.22 or later.

You or your agent can run commands from an authenticated cmux terminal:

```sh
tether open /absolute/path/to/document.md
tether open /absolute/path/to/another.md --no-focus
tether folio
tether cmux status
```

Documents open in a shared Tether pane beside the surface you launched them from. Each additional document opens in a new tab.

Opening a document from Folio uses a Tether pane in the focused workspace, preferring its active one. If there isn't a Tether pane, Tether creates a split beside the focused or last-active main pane. Links to local Markdown open in the reader's current pane. Other local files use cmux's native file handling, and website links use its browser behavior.

See [cmux keyboard shortcuts](https://cmux.com/docs/keyboard-shortcuts) for sidebar, workspace, and pane controls. Tether does not change those bindings or settings.

## Wave Terminal

Tether's Wave adapter requires Wave 0.14.5 or later. Setup looks for Wave's configuration, standard macOS application, or installed CLI, then adds a **Tether Folio** widget. Use `tether setup --wave` to request widget installation explicitly.

```sh
tether wave status
tether wave install
tether wave uninstall
```

Clicking the widget opens Folio in the visible tab. Installation leaves your other widgets alone and creates a one-time `widgets.json.tether-cutover.backup`. The widget uses the `preview` profile.

Tether does not replace Wave's native file navigator. Open Markdown using Folio or `tether open absolute/path/to/file.md`.

## Paseo (experimental)

[Paseo](https://paseo.sh) is a desktop app for coding agents. Tether runs inside it through a Paseo plugin, which lives in this repository at `integrations/paseo`. Full Folio and reader tabs require the Paseo desktop app, Paseo daemon, and Tether on the same Mac. Web and mobile clients show a basic document list.

Paseo plugins run as trusted, unsandboxed code. Install this one only if you trust this repository. Plugins are off by default; either navigate to **Settings** > **Plugins** > select **Enable Plugins**, or set `pluginsEnabled` to `true` in `~/.paseo/config.json`; run `paseo reload` after changing it. Then install the plugin:

```sh
paseo plugin add hartphoenix/tether:integrations/paseo
```

* **Folio.** In any workspace, click the Tether button in the header to open the Folio in the sidebar. Paseo gives each workspace its own Explorer, so add Folio once in each workspace where you want it. It stays there after that – show/hide it with `⌘-E`. Desktop shows Tether's full Folio: filters and saved chips, right-click menus, sorting, Active/Archive, settings, and your Tether theme. Documents, saved filters, and pins stay synchronized across workspaces. If the embedded view cannot load, a basic document list appears with **Retry full Folio**.
* **Opening documents.** Click a document in Folio to open its reader as a Paseo browser tab. Links to local Markdown open in another tab. To place a reader beside your work, split the pane first, then open it.
* **Reader panels (experimental).** Turn on **Open readers in panels** in **Settings → Tether** to open readers as Paseo tabs without an address bar or back and forward buttons. Each document gets its own tab, named for the document, which also appears in Paseo's new-tab menu while it's open. Links to local Markdown open as more panels, and web links open in your default browser. Paseo keeps only the three most recently used tabs in each pane loaded, so returning to an older reader reloads it, keeping your scroll position.
* **The Tether button.** Each workspace header gets a Tether button, which normally opens Folio. When an agent runs `tether open` or `tether recents add` for a document in that workspace, the button shows the document's name; clicking it then opens the document in Tether.
* **Focus Mode**. With a reader pane in focus, `⌘-⇧-F` fullscreens the pane and hides all others. Focus mode removes distractions and makes room for the threads drawer. `⌘-⇧-F` turns it off again.
* **Settings.** Paseo **Settings → Tether** shows the connection, turns the button on or off, and sets the `tether` command and profile. By default the plugin finds `tether` on your PATH or in `~/.local/bin`, and uses the `preview` profile.

`tether paseo status` reports whether the plugin is connected.

The embedded Folio and reader panels use a desktop webview mechanism outside Paseo's supported plugin API. If a Paseo update blocks it, the basic list remains available, and readers can be opened as browser tabs by turning reader panels off.

## Separate browser

If you're working in another terminal or agent environment, or you want to use Tether in a separate browser, enter these commands one at a time:

```sh
tether open /absolute/path/to/document.md --host browser
tether folio --host browser
```

Tether starts or reuses its local service and opens the system browser. You can bookmark these localhost locations once they're launched. If they fail to resume, it's likely the Tether service needs to restart; reuse the commands above. Browser mode doesn't provide terminal pane placement or host-specific focus controls.

## Compatibility limits

Tether checks minimum host versions, but that doesn't guarantee compatibility with every later build. If you request an operation your host doesn't support, Tether reports it without switching to a browser. Use `tether doctor` and the host status command to find out what failed.

[Recovery](recovery.md) describes how to relaunch and what saved-view recovery requires.
