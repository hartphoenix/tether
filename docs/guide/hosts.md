# Host setup

[Documentation](../README.md) · [Recovery](recovery.md)

A **host** is the app on your Mac that displays Tether's reader and Folio. Tether supports Paseo, cmux, Wave Terminal and a separate browser.

* [Paseo](#paseo)
* [cmux](#cmux)
* [Wave Terminal](#wave-terminal)
* [Separate browser](#separate-browser)
* [Compatibility limits](#compatibility-limits)

Setup chooses the host. `tether setup --host auto` uses the supported terminal you run it from, and `tether setup --host browser` uses a separate browser. To name a terminal, use `--host cmux` or `--host wave`. Inside Paseo, the Tether plugin selects the `paseo` host itself. Hosts running under the same macOS account and Tether profile share your documents and conversations.

## Paseo

[Paseo](https://paseo.sh) is a desktop app for coding agents. Tether's Paseo plugin puts Folio in each workspace's sidebar, opens documents in Tether panels, lets you annotate agent chats, and shares themes with Paseo. To install it, run `tether setup --paseo --no-open`. [Tether in Paseo](paseo.md) covers setup and use.

## cmux

Tether requires cmux 0.64.22 or later. The cmux Dock keeps Folio a hotkey away, so you can open documents in any workspace without cluttering your screen. Enable the Dock in **cmux Settings > Beta Features > Dock**; `⌘-⌥-B` then shows and hides it.

From a cmux terminal, you or your agent can run:

```sh
tether open /absolute/path/to/document.md
tether open /absolute/path/to/another.md --no-focus
tether folio
tether cmux status
```

`tether open` puts the document in a shared Tether pane beside the surface you ran it from, and each additional document opens as a new tab in that pane. A document opened from Folio goes to a Tether pane in the focused workspace, preferring the active one; if the workspace has none, Tether splits the focused or most recently active main pane. Links to local Markdown open in the reader's current pane. cmux opens other local files with its native file handling and website links in its browser.

Tether doesn't change cmux's key bindings or settings. See [cmux keyboard shortcuts](https://cmux.com/docs/keyboard-shortcuts) for sidebar, workspace and pane controls.

## Wave Terminal

Tether requires Wave 0.14.5 or later. Setup looks for Wave's configuration, the standard macOS app or Wave's CLI, and adds a **Tether Folio** widget when it finds Wave. `tether setup --wave` requests the widget explicitly. You can also manage it directly:

```sh
tether wave status
tether wave install
tether wave uninstall
```

Click the widget to open Folio in the visible tab. Installing the widget leaves your other widgets in place and saves a one-time backup, `widgets.json.tether-cutover.backup`. The widget uses the `preview` profile.

Wave's file navigator doesn't open documents in Tether. Use Folio or `tether open /absolute/path/to/file.md`.

## Separate browser

To use Tether from another terminal or agent environment, or in your own browser, run these commands one at a time:

```sh
tether open /absolute/path/to/document.md --host browser
tether folio --host browser
```

Tether starts its local service if it isn't running and opens your default browser. You can bookmark the pages once they load. If a bookmark stops working, the service has probably restarted; run the commands again. A browser can't place panes or manage focus the way the terminal hosts do.

## Compatibility limits

Tether checks each host's minimum version and never refuses a later one. A later host release can still break an integration. The Paseo plugin was tested with Paseo 0.11.2; see [Tether in Paseo](paseo.md#compatibility).

When you request something your host doesn't support, Tether reports it instead of switching to a browser. To find what failed, run `tether doctor` and the host's status command: `tether paseo status`, `tether cmux status` or `tether wave status`. [Recovery](recovery.md) covers relaunching and reconnecting saved views.
