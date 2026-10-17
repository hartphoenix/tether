# Tether in Paseo

[Documentation](../README.md) · [Host setup](hosts.md)

[Paseo](https://paseo.sh) is a desktop app for coding agents. Tether's Paseo plugin puts Folio in each workspace's sidebar, opens documents in Tether panels, lets you annotate agent chats, and shares themes with Paseo.

- [Install](#install)
- [Folio and documents](#folio-and-documents)
- [Chat annotations](#chat-annotations)
- [Settings](#settings)
- [Compatibility](#compatibility)

## Install

Packaged Tether includes a compiled plugin for Paseo 0.11.2 and later. The full Folio, reader panels and chat annotations need the Paseo desktop app, the Paseo daemon and Tether on the same Mac; Paseo's web and mobile clients show a basic document list.

Setup reports installed hosts without launching them. To install the plugin, run:

```sh
tether setup --paseo --no-open
```

The command registers the bundled plugin with the local Paseo daemon, using the CLI inside the Paseo app if `paseo` isn't on your PATH. Setup refuses only a Paseo older than 0.11.2. For any other version, it installs the plugin and notes when the version differs from the tested one. If you already have an unmanaged Tether plugin, setup keeps it and reports it for review.

Paseo plugins run trusted, unsandboxed code, so setup leaves Paseo's global plugin switch alone. Turn it on in **Settings → Plugins** when you're ready. Disable other chat annotation plugins before using Tether's.

After a Tether update, reload the plugin in **Settings → Plugins**, or run the command above again, to load the new code. A disabled plugin stays disabled. `tether paseo status` reports whether the plugin is connected.

## Folio and documents

- **Folio.** Click the Tether button in a workspace header to open Folio in that workspace's sidebar. Each Paseo workspace has its own sidebar, so you add Folio once per workspace; after that, `⌘-E` shows and hides it. On desktop, Folio has its usual filters, sorting, menus, Active and Archive views, settings and theme, and it stays in sync across workspaces. If it can't load, Paseo shows a basic document list with **Retry full Folio**.
- **Documents.** Clicking a document in Folio opens it in a Tether panel: a Paseo tab named for the document, without an address bar or back and forward buttons. Links to local Markdown open more panels, and web links open in your default browser. To put a reader beside your work, split the pane before opening the document. Paseo keeps only the three most recently used tabs in each pane loaded, so an older reader reloads when you return to it and keeps your scroll position.
- **Agent documents.** When an agent runs `tether open` or `tether recents add` in a workspace, that workspace's Tether button shows the document's name, and clicking the button opens it. Agents never move your focus.
- **Focus mode.** With a reader focused, `⌘-⇧-F` hides the other panes and gives the threads drawer more room. Press it again to restore them.
- **Themes.** Once the plugin is installed, Paseo's **Appearance** settings list Tether Light, Tether Dark, Light Treason and Dark Academia; your current theme doesn't change. In a reader's theme menu, **Inherit Paseo theme** makes Tether follow your Paseo palette.

## Chat annotations

You can comment on passages in an agent chat and send all your comments with your next message.

1. Select a passage in the chat and choose the **Comment** icon. (The **Copy** icon copies the passage without annotating it.)
2. Write your feedback, or leave it empty to send just the quote.
3. Choose **Comment**, click away or press Escape to save it. **Cancel** discards your edits.

Each saved passage gets a numbered badge. Click a badge or its highlight to edit that annotation. The **N annotations** pill above the composer lists them all; from there you can edit or delete one, or choose **Clear all**.

Send a message as usual, and your annotations go with it in the order you made them. To send only annotations, press Enter in an empty composer. Paseo's queue, steer and interrupt settings still apply. The sent message shows each quote, labeled with who said it, followed by your feedback, and you can select and annotate that text again for your next turn.

Tether clears annotations once Paseo confirms the message was accepted. Until then, it keeps the batch saved and won't let you send another annotation batch in that chat. If the pill reports a problem:

- **Check acceptance** asks Paseo whether the message arrived, without resending it.
- **Restore queued batch** appears after a restart and returns an unsent batch to Paseo's queue. Images attached to that message may not survive the restart; quotes and feedback do.

Unsent annotations stay saved until you send or delete them, including when you archive the chat.

## Settings

Open **Settings → Plugins → Tether → ⋯ → Settings**. The screen shows whether the plugin is connected and has these controls:

- **Header button** shows or hides the workspace Tether button.
- **Open documents in custom Tether panels** is on by default. If a Paseo update breaks panels, turn it off to open readers as browser tabs.
- **Tether command** and **Profile** choose the `tether` executable and profile the plugin uses. By default, the plugin finds `tether` on your PATH or in `~/.local/bin` and uses the `preview` profile. Chat annotations are stored in that profile, so reload Paseo after changing it.

## Compatibility

The plugin requires Paseo 0.11.2 or later and was tested with 0.11.2. Tether doesn't block later Paseo releases. Its embedded Folio, reader panels and chat annotations rely on parts of Paseo's desktop app outside the supported plugin API, so a later Paseo release can break them. If that happens, the basic document list still works, and turning off custom panels opens readers as browser tabs.
