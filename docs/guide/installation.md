# Installation and updates

[Documentation](../README.md) · [Recovery and backups](recovery.md)

Follow [Try Tether](../../README.md#try-tether) to install the macOS package.

The download script detects your Mac's architecture and fetches the archive for its specified version over HTTPS. It checks the archive against its embedded SHA-256 hash, then runs the packaged installer. Your first installation trusts the official HTTPS source. Later package updates check signed metadata against the public trust material already installed.

To install without opening a view, save the official release's `install.sh` asset and run `bash install.sh --no-open`. Then use `tether setup` to select a [host](hosts.md) and open the practice guide. If you're an agent handling setup, offer the optional [review skill](agent-setup.md) once and install it only if the user agrees.

Tether stores versioned releases in `~/.local/share/tether` and commands in `~/.local/bin`. To choose different locations, set `TETHER_INSTALL_DIR` and `TETHER_BIN_DIR` to absolute paths. The installer leaves your other commands and shell profiles alone. It runs setup by its absolute path and prints a PATH instruction if you need one. Temporary download files and older release directories stay available for recovery.

## Updates

If you installed via package, choose **Check for updates** from the Folio menu, or run `tether update --check`. When an update is available, a package icon with a notification dot appears in the center of the reader and Folio topbars. Click it to open the update controls: **Release Notes** opens a new tab, **Install** applies the update, and **Dismiss** hides its notice. A manual check always reports its result. If background checks keep failing for two days, a notice explains why and offers **Check now**. An installation without publisher trust material, such as a local candidate build, can't check for updates; reinstall a published release to receive them. Source checkouts update through Git.

Updates back up your private state and restart the selected runtime. Save your work before quitting a host. Reader pages reconnect without reloading; Folio reloads when the update succeeds. Run `tether doctor` if a view won't reconnect.

For a terminal update, save edits, stop the service, update, and relaunch. Run these commands separately:

```sh
tether daemon stop
tether update
tether
```

The update saves its backup beside the configuration directory, verifies the signed metadata and archive, then runs the installer. If the download or verification is interrupted, your active installation stays in place. Keep the backup and old release files if an upgrade fails. Only use an older executable with an upgraded database if you have a tested compatibility or restore procedure.

## Uninstall

`tether uninstall --confirm` removes the command symlinks and Tether Wave widgets it manages, and moves the current-release pointer aside. Your versioned releases, agent skill, Markdown, and private data stay in place. Reinstall to restore the launchers. Uninstall leaves a command alone if its target has changed.

## Independent archive verification

Get a hash confirmed by the publisher through a separate authenticated channel. Compare it with the output of `shasum -a 256` before unpacking the archive. A checksum from the same download source doesn't provide independent authentication. Run the internal installer in one go:

```sh
bash /path/to/unpacked-tether/install.sh --archive /path/to/release.tar.gz --sha256 PUBLISHER_CONFIRMED_SHA256
```

