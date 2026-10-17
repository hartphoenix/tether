# Recovery and backups

[Documentation](../README.md) · [Installation and updates](installation.md)

Agent runbook. Run commands under the user's macOS account and `TETHER_PROFILE`. Tether never edits shell startup files; ask before adding a line to one.

## Diagnose

- `tether doctor`: installation and service problems.
- `tether daemon status`: whether the service is running.
- `tether startup status`: login job, service and cmux attachment. Starts nothing.
- `tether paseo status`, `tether cmux status`, `tether wave status`: host connection.

## Fix

| Symptom | Action |
| --- | --- |
| Reader or Folio can't connect | Run `tether`. Needed after a reboot, cleared browser storage, a quit or a stopped bridge. |
| Saved tab fails: port changed or cookie lost | `tether open /absolute/path/doc.md --resume VIEW_ID --host HOST`, with `VIEW_ID` from the tab's `/s/<view-id>/` URL. The user then closes the old tab. |
| cmux panes show error pages | `tether resume --inspect` lists them without starting anything; `tether resume` reloads them. If cookies were lost, use `--resume`. |
| cmux action reports a lost connection | `tether cmux attach` in a cmux terminal. If that fails: `tether daemon stop`, then `tether folio`. |
| Wave can't reach Tether | The user clicks the **Tether Folio** widget. |
| Paseo plugin not connected | Check `tether paseo status` and Paseo **Settings → Plugins → Tether → ⋯ → Settings**. |

`--resume` keeps the view's draft and conflict base. `tether resume` never creates, focuses, closes or rearranges panes, and skips mounted readers and unidentified pages.

## Service lifecycle

- `tether` or `tether folio` starts the service, and from a cmux terminal it also attaches cmux; only cmux terminals carry cmux's authority.
- `tether daemon stop` or **Quit Tether** in Folio stops the service and bridges until the next `tether` command, shell hook or login.
- **Restart service** in Folio keeps a working cmux bridge and stops a broken one.
- The cmux bridge exits when cmux quits or relaunches, or after about 30 seconds unreachable, and logs why in `cmux-bridge.log` in the runtime directory. The Wave bridge exits when Wave stops responding.

## Login startup

`tether startup enable` (packaged installations; safe to repeat) registers a per-user LaunchAgent. It starts the service once per login, follows the `current` release across updates, and never retries a failed start.

Its result includes a `shellLine`. With the user's agreement, add it to their shell startup file, such as `~/.zshrc`; new cmux terminals then attach Tether and reload its panes. The hook stores no credentials.

If `startup status` reports `login_job_not_loaded`, the user must allow "tether" (older installations may still show the Bun runtime's developer) in **System Settings > General > Login Items & Extensions > Allow in the Background**.

`tether startup disable` removes the job and hook. If the CLI is broken, run `launchctl bootout gui/$(id -u)/LABEL` with the label from the plist path in `startup status`, then delete the plist.

## Back up and restore

A backup holds the complete private history: comments, replies, resolved threads, Folio entries, drafts and preferences. Stop the service first:

```sh
tether daemon stop
tether backup --output /absolute/path/to/new-backup-directory
```

The backup is private; it contains conversations and drafts. It writes its checksum manifest last, so an interrupted backup isn't treated as complete. It leaves out Markdown files, customized skills, skill update registrations, login startup and browser cookies. After restoring, run setup to re-register skills and recreate the guide's banner, enable login startup again if wanted, and reopen documents to get new cookies.

Restore into a new directory and run Tether against it, as two separate commands:

```sh
tether restore --source /absolute/path/to/backup --directory /absolute/path/to/restored-config
TETHER_CONFIG_DIR=/absolute/path/to/restored-config TETHER_RUNTIME_DIR=/absolute/path/to/new-runtime tether
```

Restore never overwrites existing state. Conversations still point to their original Markdown paths; use Folio's **Locate file** for moved files. Have the user check the restored data before making it their default.
