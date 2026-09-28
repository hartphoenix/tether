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

[Paseo](https://paseo.sh) is a desktop app for coding agents. Tether runs inside it through a Paseo plugin, which lives in this repository at `integrations/paseo`. Reader tabs open only in the Paseo desktop app, so the plugin is desktop-only for now. It also requires the Paseo daemon to run on the same Mac as Tether.

Paseo plugins run as trusted, unsandboxed code. Install this one only if you trust this repository. Plugins are off until `pluginsEnabled` is `true` in `~/.paseo/config.json`; run `paseo reload` after changing it. Then install the plugin:

```sh
paseo plugin add hartphoenix/tether:integrations/paseo
```

- **Folio.** Right-click the Explorer sidebar's tab rail (next to Files and Changes) and choose **Folio**. Paseo gives each workspace its own Explorer, so add Folio once in each workspace where you want it. It stays there after that. Every Folio shows the same list, filter, and pins.
- **Opening documents.** Click a document in Folio to open its reader as a Paseo browser tab. Links to local Markdown open in another tab. To place a reader beside your work, split the pane first, then open it.
- **The Tether button.** Each workspace header gets a Tether button, which opens Folio. When an agent runs `tether open` or `tether recents add` for a document in that workspace, the button shows the document's name. Nothing opens until you press it, so an agent never moves your focus.
- **Settings.** Paseo **Settings → Tether** shows the connection, turns the button on or off, and sets the `tether` command and profile. By default the plugin finds `tether` on your PATH or in `~/.local/bin`, and uses the `preview` profile.

`tether paseo status` reports whether the plugin is connected.

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
