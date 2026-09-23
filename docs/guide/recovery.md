# Recovery and backups

[Documentation](../README.md) · [Installation and updates](installation.md)

If a reader can't connect, run `tether` again. Use `tether doctor` to check your installation and service, or `tether daemon status` to inspect the daemon. If access needs renewal after you quit a host, relaunch from that host's terminal.

## Saved views

When your host restores a tab, it needs Tether's local service at the saved address and the browser cookies it kept from that session. Tether saves your reader drafts, conflict state, and reading positions; your host restores the tabs themselves.

A loaded page retries automatically if it loses its connection. If the host can't load Tether's page in the first place, that retry code can't run.

Launch Tether again after a reboot, after clearing browser storage, or if you explicitly quit Tether or stop a host bridge.

If another process occupies the saved port, the daemon moves to a different one. Reopen the document with its saved view ID:

```sh
tether open /absolute/path/to/document.md --resume VIEW_ID --host browser
```

Take the ID from the reader's `/s/<view-id>/` URL and choose the host you want. The command renews access to that document and view with a new cookie, keeping its draft and the base revision used to check conflicts. It opens a view without rearranging your existing tabs. If the port changes, origin-scoped Folio display preferences may reset; reader drafts and positions remain in Tether's saved view state. Once you've recovered the document, close the obsolete tab. You can relaunch Folio normally.

## Existing cmux panes

From a cmux terminal, `tether resume --inspect` reports eligible panes without starting the service or navigating. `tether resume` starts the service and repairs positively identified Tether error pages in existing panes. It does not create, focus, close, or rearrange panes, reload mounted editors, execute terminal history, or renew browser authorization. Unknown pages, loading pages, duplicate view IDs, and native browser error documents that cmux cannot inspect are skipped. If cookies were lost, explicitly reopen the document as described above.

## Optional login startup

Packaged macOS installations support `tether startup status`, `tether startup enable`, and `tether startup disable`. Installation leaves startup disabled. Stop Tether before enabling it; enabling registers a per-user LaunchAgent and starts the pinned installed runtime. Source checkouts cannot register themselves.

For cmux attachment, source the `hook` path returned by enable from an interactive cmux shell's startup file. Tether does not edit shell files. The hook needs the fresh capability provided by cmux; credentials are never saved. cmux must restore a terminal that executes the hook. Restoring browser panes alone cannot establish that authority.

The login job runs once per login, with no KeepAlive, timer, or automatic crash retry. A persistent attempt marker is created before the application starts. A crash, failed import, missing executable, or interrupted startup leaves it blocked across subsequent logins. Inspect `startup status`, fix the cause, stop remaining processes, then explicitly enable again to reset the block. A clean shutdown permits the next login. Fast user switching leaves each account's processes and private state separate.

`daemon stop`, Quit, and `startup disable` suppress future automatic starts. `daemon restart` transfers the current automatic attempt to its successor. Updates disable automation; re-enable against the new installation after verification. Changing the installed runtime also invalidates another profile's pinned runtime. Background restoration does not activate retention cleanup until an explicit open or activation.

`startup disable` unloads the job, stops Tether and its bridges, and removes an unchanged owned plist; its result reports incomplete cleanup. Uninstall refuses to proceed if that cleanup fails. Save the `disableMarker` and `target` returned by enable: if the CLI itself is broken, create that marker with `/usr/bin/touch /absolute/path/to/startup-disabled`, then run `/bin/launchctl bootout TARGET` using the saved target. The shell guard honors the marker before loading Bun. Do not delete attempt markers to force repeated retries.

Native cmux recovery still needs validation on the host/version in use. Tether restores its saved view state; cmux owns workspace layout and other terminal processes.

## Private review backup

A `.tether` export shares open conversations, leaving out resolved history and recovery state. To back up your private review history and recovery records, run:

```sh
tether daemon stop
tether backup --output /absolute/path/to/new-backup-directory
```

The daemon must be stopped before backup can run. The command holds the startup lock while taking a consistent SQLite snapshot, then copies your preferences, launch and update preferences, the Recents index if present, and Tether's welcome Markdown documents. It writes a checksum manifest last, so an interrupted copy won't be treated as a complete backup.

Keep the backup directory private: it contains your conversation history and drafts. Back up your ordinary Markdown files separately.

Restoring the backup brings back comments, replies, resolved history, Folio entries, saved reader drafts, and preferences. Some parts of your setup need separate attention:

- Your ordinary Markdown files and customized agent skill need separate backups.
- The backup leaves out the list of skills enrolled in automatic updates and any proposed updates awaiting review. Use setup to register a restored skill again. Keep a customized copy for review, since setup won't overwrite it with different instructions.
- The practice guide's banner image isn't included. Run setup in the restored profile to recreate it.
- Login startup is not restored; explicitly enable it for the verified installation.
- Browser cookies stay in the browser. If you lose them, open your documents again to authorize new views.

Choose a new directory for the restore. The command won't overwrite existing state:

```sh
tether restore --source /absolute/path/to/backup --directory /absolute/path/to/restored-config
TETHER_CONFIG_DIR=/absolute/path/to/restored-config TETHER_RUNTIME_DIR=/absolute/path/to/new-runtime tether
```

Use a new runtime directory to keep the recovered setup separate. Document paths still point to their original Markdown files; use Folio's Locate action if you've moved them. Check the recovered data before making it your default configuration. Your history and recovery records are restored, but lost browser cookies aren't.
