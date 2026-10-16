# Installation and updates

[Documentation](../README.md) · [Recovery and backups](recovery.md)

To install the macOS package, follow [Try Tether](../../README.md#try-tether).

## How installation works

The download script detects your Mac's architecture and fetches the release archive over HTTPS. It checks the archive against the SHA-256 hash embedded in the script, then runs the packaged installer. A first installation trusts the official HTTPS source; later updates verify signed metadata against the public trust material the first installation put in place.

The installer puts versioned releases in `~/.local/share/tether` and the `tether` command in `~/.local/bin`. To use other locations, set `TETHER_INSTALL_DIR` and `TETHER_BIN_DIR` to absolute paths. The installer doesn't change your other commands or your shell profiles; if `~/.local/bin` isn't on your PATH, it prints the line to add. It keeps temporary download files and older release directories for recovery.

When it finishes, the installer runs `tether setup`, which opens the getting-started guide and then this release's notes. To install without opening anything, save the official release's `install.sh` and run `bash install.sh --no-open`; afterward, run `tether setup` to choose a [host](hosts.md) and open the guide.

Setup reports whether Paseo, cmux and Wave are installed, and which version, separately from whether they're connected. It adds the Wave Folio widget automatically. The Paseo plugin and the agent skills install only when you accept them: the plugin through `tether setup --paseo --no-open`, the skills as described in [agent setup](agent-setup.md). Agents handling setup should offer the skills once and install them only if the user agrees. Updates need no account or mailing-list registration.

## Updates

In a packaged installation, choose **Check for updates** from the Folio menu or run `tether update --check`. When an update is available, a package icon with a notification dot appears in the middle of the reader and Folio toolbars. Click it for the update controls: **Release Notes** opens the notes in a new tab, **Install** applies the update, and **Dismiss** hides the notice. A manual check always reports its result. If background checks keep failing for two days, a notice explains why and offers **Check now**.

An installation without publisher trust material, such as a local candidate build, can't check for updates; reinstall a published release to get them. Source checkouts update through Git.

Before installing, an update backs up your private state; afterward, it restarts the Tether service. Save your work before quitting a host. Open readers reconnect without reloading, and Folio reloads once the update succeeds. The first reader or Folio view to load the new version opens its release notes in a new tab. If a view won't reconnect, run `tether doctor`.

To update from the terminal, save your edits, then run these commands one at a time:

```sh
tether daemon stop
tether update
tether
```

The update saves its backup beside the configuration directory, verifies the signed metadata and the archive, and then runs the installer. If the download or verification is interrupted, your current installation stays in place. If an upgrade fails, keep the backup and the old release files. Don't run an older `tether` against a database that a newer version has upgraded unless you have a tested way to restore it.

After an update, reload the Paseo plugin in Paseo's **Settings → Plugins** when you're ready; an update never enables a disabled plugin. To accept newly offered skills or integrations, run setup again.

## Uninstall

`tether uninstall --confirm` removes the `tether` command links, Tether's Wave widgets and the packaged Paseo plugin registration that Tether manages, and moves the current-release pointer aside. If a command link now points somewhere else, uninstall leaves it alone. Your versioned releases, agent skills, Markdown files and private data stay in place, and reinstalling restores the launchers.

## Verify an archive independently

Get the archive's hash from the publisher through a separate, authenticated channel; a checksum from the same download source doesn't authenticate anything. Compare it with the output of `shasum -a 256` before unpacking the archive. Then run the unpacked installer, as a single command:

```sh
bash /path/to/unpacked-tether/install.sh --archive /path/to/release.tar.gz --sha256 PUBLISHER_CONFIRMED_SHA256
```
