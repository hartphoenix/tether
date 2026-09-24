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

From a cmux terminal, `tether resume --inspect` lists the panes that would be reloaded, without starting the service or navigating. `tether resume` starts the service and reloads existing Tether panes that show an error page, including browser error pages from when the service was down. It skips mounted readers and pages it can't identify as Tether's, and doesn't create, focus, close, or rearrange panes. A running cmux bridge does the same automatically when it attaches or the service restarts, once per pane. If cookies were lost, reopen the document as described above.

## Starting and stopping

- `tether` (or `tether folio`) starts everything. Run it in a cmux terminal to connect cmux.
- `tether daemon stop`, or **Quit** in Folio, stops the service and its host bridges. Nothing is disabled: the next `tether`, shell hook, or login starts it again.
- **Restart service** in Folio restarts the service. A cmux bridge that still works stays attached; one that doesn't is stopped, and the next cmux terminal reattaches.

The cmux bridge rides out brief outages such as sleep; it exits only when cmux relaunches or stays unreachable for about 30 seconds, and records why in `cmux-bridge.log` in the runtime directory. With the shell hook installed (`tether startup enable`), the next prompt in any cmux terminal reattaches it. Otherwise, when a cmux action reports that Tether lost its connection, copy the command it shows and run it in any cmux terminal: `tether cmux attach`. If that fails, `tether daemon stop` followed by `tether folio` resets every connection.

In Wave, click the **Tether Folio** widget to reconnect.

## Login startup

Packaged macOS installations can start Tether at login:

```sh
tether startup enable
```

This registers a per-user LaunchAgent that starts the service once per login. It follows the installation's `current` release, so updates don't require re-enabling. It never restarts a failed service; the next login or `tether` command tries again. Logging out stops it.

cmux panes need cmux's own authority, which only a cmux terminal has. The enable result includes a `shellLine`; add it to your interactive shell startup file (for example `~/.zshrc`):

```sh
[ -r '/path/from/enable/cmux-startup.sh' ] && . '/path/from/enable/cmux-startup.sh'
```

Each new cmux terminal then attaches Tether in the background. The first restored terminal after login reconnects cmux and reloads Tether panes. If cmux restores only browser panes, open any terminal tab. Tether never edits shell files, and the hook stores no credentials.

A cmux bridge lasts as long as the cmux process that started it. When cmux quits, relaunches, or you log out, the bridge exits and the next cmux terminal attaches a new one. A Wave bridge exits once Wave stops responding.

macOS lists the login job under **Allow in the Background** in System Settings > General > Login Items & Extensions as "Jarred Sumner", the developer of the bundled Bun runtime. If that item is off, macOS skips the job at login without an error, and `startup status` reports `login_job_not_loaded`.

`tether startup status` reports what is enabled and connected. `tether startup disable` removes the login job and hook; the shell line then does nothing. If the CLI itself is broken, remove the job with `launchctl bootout gui/$(id -u)/LABEL` using the label from the plist path in `startup status`, then delete that plist.

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
