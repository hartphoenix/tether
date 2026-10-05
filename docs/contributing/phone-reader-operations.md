# Phone reader operations

The source pilot can run under a macOS launchd user agent, with CLI start, stop, restart, status, logs and deploy commands. This is separate from Tether's signed release publisher.

## Current review

Restart waits for launchd to remove the exiting job before starting its replacement. Waiting only for closed ports allowed an exiting job to be mistaken for a running one, skipping bootstrap and leaving the service stopped. The native regression check covers installation, repeated restarts and a deployment with isolated state.

## Prepare and install

Use the original operations checkout for every command. Do not move it after installation: launchd and the snapshot pointer use absolute paths. Configuration and code snapshots live under its ignored `.local/phone-reader-ops/`; passkey and document state stay at their existing paths.

Run `bun scripts/phone-reader-ctl.ts configure --document FILE --owner LOGIN --reader-origin https://READER_HOST --approval-origin https://APPROVAL_HOST --state-dir EXISTING_STATE_DIR` once. This records non-secret runner arguments and generates a plist inside the checkout. It neither loads a service nor reads the credential store. Configuration is intentionally refused once present, to avoid silently repointing a live service.

Commit the intended code, then run `bun scripts/phone-reader-ctl.ts prepare COMMIT`. Preparation exports that Git commit into a separate directory, installs frozen Bun dependencies plus the npm-locked Paseo test dependencies (matching CI), and runs `bun run check`. Only successfully checked snapshots become deployable. Uncommitted development edits cannot affect the running snapshot. Use trusted refs: installation and checks execute code from the selected commit. The existing Playwright Chromium installation must be available to the logged-in user.

After the owner approves installation and stops the old foreground runner, run `bun scripts/phone-reader-ctl.ts install COMMIT`. This copies the generated plist to `~/Library/LaunchAgents/net.tether.phone-reader.plist`, loads it into the current GUI login domain and verifies both local surfaces. It refuses occupied ports and never kills an unmanaged runner. Failed initial startup stops the managed service; inspect logs before retrying `start`.

The user agent starts on login and restarts after exits. It does not keep the Mac awake or run while the user is logged out. The second Tailscale process remains independently managed; a healthy local runner does not prove either HTTPS route is available.

## Control and deploy

Run `bun scripts/phone-reader-ctl.ts COMMAND`:

| Command | Effect |
| --- | --- |
| `start` | Load the installed service if needed; verify the selected revision on both ports. |
| `stop` | Unload only this service; wait for its launchd registration to disappear and its two ports to close. It stays stopped until `start` or the next login. |
| `restart` | Stop and start; browser sessions end. |
| `status` | Report supervisor presence, selected snapshot, and running revision for each local surface. Exit nonzero if unhealthy or mismatched. |
| `logs` | Print the last 80 lines of each runner log; no credential-store access. |
| `prepare REF` | Check an isolated committed snapshot without touching the live service. |
| `deploy REF` | Prepare first, stop, atomically switch the code pointer, start and check health; restore the previous snapshot if startup fails. |

`GET /health` is available only with the exact loopback host and port, and returns service, surface and revision. Public HTTPS Host requests still pass through the normal gateway. Health means the runner initialized both listeners and its backend; it does not exercise real passkey verification, lazy diagram rendering or Tailscale routing. Snapshots report the full Git commit; foreground source runs report `development`.

Operations are serialized with a directory lock. After a killed controller, inspect `status`, the `current` symlink and any active preparation process before removing a stale `.local/phone-reader-ops/operation.lock`. A process interruption or machine failure during cutover is not automatically rolled back; select a known prepared release with `deploy REF` after clearing a confirmed stale lock. Completed snapshots are retained for rollback and are never automatically pruned. Logs are local files with no rotation in this pilot.

Rollback switches code only. Document, review and passkey state are never restored or deleted. Deploy only versions compatible with the current persisted state; schema migration recovery requires a separate plan. Preparation failures leave the running release unchanged. If both deployment and rollback fail, the command reports failure and leaves diagnosis to `status` and `logs`.

## Authority and verification

The supervisor never passes `--enroll`; enrollment remains an interactive owner operation in the foreground runner. The controller neither reads nor rewrites credential files, and does not alter Serve, tags, ACLs or Tailscale daemons. Agents controlling arbitrary source deployments under the same macOS account are not isolated from that account's filesystem by this design; these operational limits are not a new OS permission boundary.

Run `bun run check` for controller rollback and health tests plus the full repository checks. Run `bun scripts/check-phone-reader.ts` for disposable browser authentication, mobile layout and gateway behavior. Neither command touches enrolled live credentials. After installation, verify `status`, `restart`, and a physical-phone login before treating the live cutover as complete.

On macOS, run `bun scripts/check-phone-reader-ops.ts` for the native lifecycle regression. It temporarily installs a separate test label, uses OS-selected loopback ports and disposable document/state, verifies three restarts with new PIDs and a deployment, then unloads and removes the fixture. It copies the current source into synthetic prepared releases; it does not test dependency installation or touch the live pilot, Tailscale, or enrolled credentials.
