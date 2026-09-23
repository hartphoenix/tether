# Host setup

[Documentation](../README.md) · [Recovery](recovery.md)

"Host" here refers to your local terminal environment's embedded browser (such as cmux or wave, which Tether provides adapters for), not a cloud platform or remote server.

Run `tether setup --host auto` to use the supported terminal you’re working in, or `tether setup --host browser` to use a separate browser. You can select a terminal explicitly with `--host cmux` or `--host wave`. Your local data is shared across hosts that use the same account and profile.

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
