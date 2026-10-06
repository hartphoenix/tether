# Shared profiles

A shared profile has one service and one review database. Markdown stays on its file machine; an outbound connector lets the service read and save files elsewhere. Browsers and agent CLIs use the same Folio, document IDs, comments, and preferences. The service and file machines can each run macOS or Ubuntu; neither placement requires a desktop host or VPN.

This is a source deployment. Keep its checkout and Bun installation at stable paths. The generated Ubuntu service configuration and filesystem behavior need verification on the Ubuntu installation before relying on it; generating a systemd unit on macOS does not verify Linux operation.

## Prepare the source runtime

Install Bun 1.3.9 and use a checkout of this repository under the account that owns the files. From that checkout, install the pinned dependencies and build the browser assets:

```sh
bun install --frozen-lockfile && bun run build:web && echo "Tether source runtime prepared"
```

The service renders diagrams in offline, sandboxed Chromium. Install the Playwright browser on the service machine; a connector does not need Chromium. On macOS:

```sh
bun node_modules/playwright/cli.js install chromium && echo "Diagram browser installed"
```

On Ubuntu, Playwright also needs its documented OS libraries; its installer may request administrator access for those packages:

```sh
bun node_modules/playwright/cli.js install --with-deps chromium && echo "Diagram browser and libraries installed"
```

Do not disable Chromium's sandbox. See [Playwright's browser installation instructions](https://playwright.dev/docs/browsers#install-system-dependencies).

## Configure one service

Choose a profile and a dedicated public HTTPS origin, such as `https://tether.example.net`. For an existing local library, use its existing profile; configuring a new profile creates a separate library. Stop its daemon before configuring the shared listener:

```sh
TETHER_PROFILE=shared ./tether shared configure --origin https://tether.example.net --port 8420 --owner owner && echo "Shared listener configured"
```

The shared listener binds to `127.0.0.1:8420`. Put a TLS reverse proxy on the same machine and forward only this port. Keep the configured public `Host` header; browser `Origin` must exactly match the configured HTTPS origin. Forwarded identity headers grant no access. The local daemon control listener must remain private.

For example, an independently configured Caddy server can terminate HTTPS with:

```caddyfile
tether.example.net {
    reverse_proxy 127.0.0.1:8420 {
        header_up Host tether.example.net
    }
}
```

Use a valid certificate, allow connector request bodies up to 46 MiB, and allow at least 60 seconds for long polls. This example depends on your DNS and proxy setup; see [Caddy's reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Tailscale can provide the network route, but shared-profile authentication still applies.

Generate a foreground launcher and a service-manager configuration in a new directory. This command does not start or register a service:

```sh
bun scripts/install-headless.ts --role service --profile shared --directory "$HOME/tether-service" && echo "Service launcher and supervision file generated"
```

The launcher points to the current checkout and Bun executable. `--checkout`, `--bun`, `--config-directory`, and `--runtime-directory` select explicit paths when needed. It retains source dependencies and launches no reader window.

## Supervise the process

On macOS, register the generated user agent; it starts while that user's login session is available:

```sh
mkdir -p "$HOME/Library/LaunchAgents" && cp "$HOME/tether-service/org.tether.source.service.shared.plist" "$HOME/Library/LaunchAgents/" && launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.tether.source.service.shared.plist" && echo "Tether service registered"
```

On Ubuntu, register the generated user service:

```sh
mkdir -p "$HOME/.config/systemd/user" && cp "$HOME/tether-service/org.tether.source.service.shared.service" "$HOME/.config/systemd/user/" && systemctl --user daemon-reload && systemctl --user enable --now org.tether.source.service.shared.service && echo "Tether service registered"
```

An Ubuntu user service needs that user's systemd manager running. If it must survive logout, the administrator can enable lingering for that account. The generated configuration uses foreground execution and restart supervision; see the [systemd service reference](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

macOS logs are in the generated directory; Ubuntu logs are in the user journal. Stop the supervisor before backup, reconfiguration, or source updates, so it cannot restart the daemon during maintenance. To update, stop the process, update the checkout and pinned dependencies, rebuild the browser assets, then restart it; connectors and services must use a compatible protocol version.

## Enroll the owner and clients

On the service machine, including through your own SSH session, begin owner enrollment:

```sh
TETHER_PROFILE=shared ./tether shared enroll && echo "Use the displayed verification address and one-use code"
```

Complete the displayed ceremony at the configured HTTPS origin. Enrollment codes last five minutes. The owner passkey approves client enrollment and account changes; a document token cannot approve another client. Opening `/` in a browser offers passkey sign-in and then the shared Folio. `/auth/clients` lists clients and offers individual revocation after owner verification.

On a file machine, request its connector credential:

```sh
./tether remote pair --origin https://tether.example.net --name "Server files" --kind connector --connection "$HOME/.config/tether/server-connection.json" && echo "Approve the displayed client request with the owner passkey"
```

After owner approval, complete the request on that same machine:

```sh
./tether remote complete --connection "$HOME/.config/tether/server-connection.json" && echo "Connector credential saved privately"
```

Generate its launcher, then register the resulting `org.tether.source.connector.shared` unit using the platform's supervision commands above:

```sh
bun scripts/install-headless.ts --role connector --profile shared --directory "$HOME/tether-connector" --connection "$HOME/.config/tether/server-connection.json" && echo "Connector launcher and supervision file generated"
```

For a foreground run, use:

```sh
echo "Starting the connector; press Ctrl-C to stop" && ./tether connector run --connection "$HOME/.config/tether/server-connection.json"
```

That command runs until stopped. One connector process owns the file-machine identity; reconnects keep it stable. To renew an existing file machine's credential, pass its existing machine ID to `remote pair --machine <machine-id>` and approve that request. Revocation stops file service without deleting its documents or reviews.

Enroll agent CLIs and receiving desktop clients with the same pairing commands using `--kind agent`. Credentials remain in owner-only local files; do not put them in document URLs, shared preferences, shell arguments, or logs. Browser sessions last 30 days; agent and connector credentials last 90 days. Re-enroll expired clients.

## Documents, readers, and saves

Remote CLI calls accept `--connection <private-file>` and document references such as `id:<uuid>`. List file machines with `tether remote machines --connection <private-file>`. A path input also selects its file machine with `--machine <machine-id>`; paths are resolved there. Browser path entry likewise supplies a machine selector. Registration verifies the file and adds it to the shared Folio without another document-consent step. Separate copies and worktrees get separate identities.

For example, register a server file and read it by the returned document ID:

```sh
./tether folio add /path/document.md --machine machine-uuid --connection "$HOME/.config/tether/agent-connection.json" && echo "Document registered in the shared Folio"
```

```sh
./tether document read id:document-uuid --connection "$HOME/.config/tether/agent-connection.json" && echo "Current server document read"
```

Readers keep editing and review controls, including on supported mobile browsers. Following a local Markdown link resolves it on its source machine and registers an accessible target. An archived target asks “This document has been archived. Restore it?”; cancellation leaves the existing record archived. Relink preserves a document's UUID and reviews, verifies the destination, and rejects collisions and stale location handles. Managed remote file moves are unavailable.

For reader delivery, an agent targets an enrolled receiving client with `tether open id:<uuid> --connection <private-file> --receiver <client-id>`. Run `tether remote receive --connection <private-file> --host cmux` in the receiving cmux terminal to open background reader tabs in that captured workspace. In Paseo, use `--host paseo` from the intended workspace with the Tether plugin connected; its document notice opens the shared URL only after a human click. Neither announcement moves focus or restarts an agent. A Mac hosting the profile can also open remote documents through its existing local Folio and host integration.

The receiver always prints the public reader URL and delivery result before acknowledging it. Wave and ordinary browser adapters currently report unsupported background placement and leave that link available to click; a host delivery failure also leaves the link in the output. Receiving hosts use their own passkey-authenticated browser session. No credential travels in the URL, and no missing native integration is replaced by a browser launch.

An unavailable file machine cannot supply a current body or accept saves. Historical reviews remain available with unavailable anchor context. A disconnected connector, confirmed missing file, stale revision, and unknown save outcome are separate states.

If a response is lost, keep the attempted text and original base revision. “Save not yet confirmed” requires a fresh read after the connector has drained earlier work. If current text matches the draft, the file contains that edit; this does not identify which request wrote it. If it still matches the base, retry explicitly with the original expected revision. Otherwise compare and reconcile. Do not refresh the revision merely to overwrite an external edit.

CLI saves require both `--expected-body-revision` and `--expected-location-version` from the preceding document read, plus `--body-file <attempted-text-file>`. After a lost response, `tether document verify-save id:<uuid>` accepts those same three flags and `--connection`; it returns `matches_edit`, `matches_base`, or `diverged` with current revision metadata. It never repeats the write. For unavailable files, `tether document history id:<uuid> --connection <private-file>` returns bounded historical thread summaries; select `--thread <id>` for messages and follow `--continuation <token>` until complete.

## Recovery, backup, and relocation

`tether shared recover` is the local OS-owner recovery path when the passkey is unavailable. Complete the replacement ceremony at the configured HTTPS origin, then review authorized clients. Recovery keeps documents, reviews, and enrolled clients; revoke unwanted clients individually.

Use the existing [backup and restore commands](recovery.md) after stopping supervision and the daemon. Backups include the authoritative private database and shared authentication/configuration state, but not arbitrary Markdown files or client credential files. Back up those files separately. The phone pilot's separate store is not merged automatically.

Restore into a new directory. A restored shared service remains fenced until you stop the previous authority and run `tether shared activate --confirm` against the restored configuration. Use `--same-file-machine` only when the restored service still runs on the original file machine. Otherwise activation assigns the new service its own local machine identity; enroll the original machine's connector using its preserved machine ID so existing locations still refer to their original files.

Never run two writable services from the same restored profile or mount its SQLite database across the network. During cutover, keep the old service stopped, select one origin and authority, then test IDs, reviews, acknowledgements, and file routes before resuming edits. Rollback requires stopping the replacement first; retain any changes made since cutover rather than silently replacing them with an older backup.

Changing the HTTPS origin requires explicit client connection updates and local owner recovery at the new origin. Credentials are never forwarded through redirects. Keep the old endpoint unavailable during that change so clients cannot write to two authorities.
