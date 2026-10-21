# Tether CLI reference

[Documentation](../README.md) · [Protocol details](protocol.md)

Use `tether` from an installed package, or `./tether` and `./mdreview` from a source checkout. Run commands under the same OS account and `TETHER_PROFILE` as the reader. To install the optional review skill, see [agent setup](../guide/agent-setup.md).

Start with `tether --help` to find a command group, then use focused help such as `tether reply --help` for its exact flags. Replace the uppercase ID placeholders in these examples with the values Tether returns.

## Review comments

Pending identifies changed events without returning their bodies or anchors. Read each affected thread once when current text is needed. If you're missing passage context, ask for nearby text or an outline before reading the full document.

```sh
tether pending /path/to/doc.md --actor "Go button review"
tether thread /path/to/doc.md THREAD_ID
tether document context /path/to/doc.md THREAD_ID
tether document outline /path/to/doc.md
```

Follow every continuation before acknowledging. Each page of pending events has its own review cursor. Once you've handled that page and all preceding pages, acknowledge the last fully reviewed page's cursor. Don't start a fresh pending read just to get a newer cursor.

An index is not completed review. Handle every listed event or assign a clear next owner before acknowledging. Check `reviewState` even when `events` is empty: `changed` supplies `acknowledgedBodyRevision` for `document diff --from-revision`; if that revision is unavailable, inspect relevant body content. `never_reviewed` requires inspecting relevant document content before acknowledging. A later thread read may contain newer events; keep using the original pending cursor.

Use `event FILE EVENT_ID` for immutable historical details when current thread text is insufficient. An edit event contains its edited text; a deletion identifies its target. Reading that `targetId` returns the original message, so inspect intervening edit events when their text matters. Resolution/deletion metadata alone may suffice when no text-dependent action remains.

Acknowledgement records what the agent has reviewed. Resolution records whether the human still needs to read or act on a thread.

```sh
tether reply /path/to/doc.md THREAD_ID --actor "Go button review" --body-file /tmp/reply.txt --operation-id UNIQUE_ID --expected-thread-sequence THREAD_SEQUENCE
tether acknowledge /path/to/doc.md --actor "Go button review" --cursor REVIEWED_CURSOR --operation-id ANOTHER_UNIQUE_ID
```

If you retry an annotation change, keep the same operation ID and identical inputs. Look up its receipt with `tether operation <file> --operation-id <id>`. A missing receipt means `outcome_unknown`; the change may still have happened. A replayed receipt's `appliedSequence` is historical; refresh the thread before another guarded write.

Use `--expected-thread-sequence` to reject stale replies, edits, deletions, resolutions, or reopenings. Both `edit` and `delete` take a thread ID and the original comment or reply ID. They append private review events; `delete` leaves the Markdown file alone.

### Agent identity

Review, turn and save commands sign their work with an agent ID, which never changes. The CLI takes it from `--agent-id`, then `PASEO_AGENT_ID` (as `paseo:ID`), then `CLAUDE_CODE_SESSION_ID` (as `claude:ID`). Without any of these, the daemon issues an ID at the first command and returns it as `agent: {id, name, issued: true, next}`; pass it with `--agent-id` on every later command. An issued ID whose command failed is discarded.

`--actor` sets the agent's display name, such as the role it's working in. Names are unique, ignoring case, among agents seen in the last 24 hours; a name another such agent holds is refused with `agent_name_taken`. The human can rename an agent in the reader by right-clicking its name. After that, the agent's `--actor` no longer changes its name, and results include `agent: {id, name, next}` with the name the reader shows. `--actor human` signs as the human reader.

Events, receipts and turn registrations store the ID as the author, and the reader shows the ID's current name, icon and color. Pending results exclude the agent's own events by ID. The `consumer` value identifies whose acknowledgements to track and defaults to the agent ID. Use `--consumer` on pending and acknowledge to track reviewers independently, or use the exact same string to share progress. Records written before agent IDs carry plain strings such as `assistant`, which serve as both ID and name.

`document save` accepts optional `--actor` and `--agent-id`, which register or refresh the agent the same way.

## Turn signals

The reader shows one **Go** button per registered agent on a document. A human reader press or an explicitly authorized local CLI send starts delivery. Agent registration does not grant authority to press buttons.

```sh
tether turn assign handoff:REFERENCE [--name NAME] [--icon ICON]
tether turn takeover handoff:REFERENCE
tether turn resume handoff:REFERENCE
tether turn register /path/to/doc.md --actor NAME [--agent-id ID] [--host-id PASEO_DAEMON_ID] [--label TEXT] [--icon ICON] [--if-empty]
tether turn takeover /path/to/doc.md --role-id ROLE_ID --expected-recipient SESSION_ID [--host-id PASEO_DAEMON_ID]
tether turn status /path/to/doc.md
tether turn send /path/to/doc.md --agent-id ID --operation-id UNIQUE_ID
tether turn unregister /path/to/doc.md [--actor NAME] [--agent-id ID]
tether turn wait /path/to/doc.md --actor NAME [--agent-id ID] [--label TEXT] [--after CURSOR] [--timeout SECONDS]
```

Commands use the [step-one agent identity](#agent-identity), including `paseo:PASEO_AGENT_ID`. `register` returns `{registration: {agentId, state, label?, reason?}}` without holding a watcher. Only hosts with delivery support can register; others use `wait`. Registrations survive the watcher grace and daemon restarts. `unregister` removes the caller's button and cancels held delivery/monitoring, returning `{removed: boolean}`; it does not interrupt an accepted agent turn. Outside a host environment, pass the same `--agent-id` used to register. Labels are at most 60 characters; icons, colors and names come from the identity registry.

`status` also returns `availableIcons`. A new identity can choose one with `register --icon`; the daemon assigns its color using the existing rotation. An existing identity keeps its icon. `--if-empty` refuses registration if any agent already occupies the document, so a copied empty-slot prompt cannot silently add a second agent.

`takeover` requires a Paseo receiving session and a durable host registration. It transfers the role across all its registered documents, retaining the immutable ID, display name, icon, color, labels and review attribution. The CLI infers the new session from its environment; do not pass the old role ID as `--agent-id`. The result contains `{identity, recipientId, registrations, instructions}`. Follow the returned instructions to read the document and pending threads, adopt its role, and handle outstanding work. Failed CLI takeovers include stop/recovery instructions in `error.details.instructions`. Later commands from the replacement session sign as the role automatically; the retired session is refused. A different current receiver causes a conflict; retrying for the same replacement is safe.

Takeover retires outstanding invitations without replaying them. It does not stop work already begun by the previous session or transfer that session's private memory. Registrations owned by another connection cannot be taken over; preserve the configured Fly receiver. Future mention tokens can continue to target the unchanged role ID.

`GET api/turn-prompt` returns an empty-slot assignment prompt; `?agentId=ROLE_ID` returns a role takeover prompt. The Go context menu’s **Add another agent** action uses `?add=1` to copy an assignment prompt that permits an additional registration and confirms the copy. This flow refuses a caller already registered on the document; existing roles remain assigned. Each contains one sentence and a command with a handoff reference. References expire after seven days and survive daemon restarts. They select an operation; the existing control credential still authorizes it. Local prompts retain the profile and executable; shared prompts use the agent's configured connection.

`assign` and handoff-based `takeover` require a connected Paseo turn adapter. Assignment atomically checks the empty slot, preserves an existing caller identity or creates one using the document title, available icon and color rotation. Optional `--name` and `--icon` apply to new identities. Both commands return identity, registrations, document text, a bounded pending page and up to three thread pages in `context`. `context.next` contains CLI argument arrays for remaining pages; use the same executable, profile and connection. Review the content before acknowledging its cursor.

The daemon stores the mutation and handoff receipt together. Repeating the same command verifies the current receiver and retrieves context without repeating assignment. The CLI automatically retries once after an uncertain response. If setup succeeds but context retrieval fails, the result reports `outcome: applied`, an `onboarding_incomplete` warning and `resume` arguments. `turn resume` only verifies the receipt and reads context. A different caller, expired reference or subsequently changed assignment is refused.

Connection failures distinguish unverified access from stale assignments. A network-restricted shell may block localhost even when the daemon is healthy; these commands do not bypass that restriction or change session permissions. Use an authorized connection or permission retry.

| State | Meaning |
| --- | --- |
| `ready` | A press can be accepted. |
| `queued` | A press is held pending host acceptance, including while the agent is busy. |
| `working` | The host accepted the message, or an armed watcher received the press; turn completion is pending. |
| `unavailable` | Delivery or completion could not be confirmed; `reason` explains why. No automatic replay. |

`POST api/turn` accepts `{agentId, operationId}`; reuse the operation ID when checking an uncertain request. Host delivery returns `{signalId, agentId, state, reason?}`; watcher delivery also includes `cursor` and `sequence`. `GET api/turns` returns agent state, the effective busy-agent behavior, reason, signal ID and acceptance time. `GET api/turn-events` streams those snapshots to the reader. Repeated operation IDs return the original signal; a different target with the same ID is rejected.

Paseo's server plugin owns delivery, independently of the app and model. Subscriptions bind a document UUID, file machine, agent ID, Paseo daemon ID and connection. Registration infers the local daemon ID from `TETHER_PASEO_HOST_ID` or `PASEO_HOME/server-id`; use `--host-id` for an explicit binding. Fly accepts `id:UUID --connection FILE`, with `--receiver CLIENT_ID` when the plugin has its own enrolled connection. Agent credentials can register and inspect; they cannot send turns. A human can send through the hub's local CLI.

Accepted presses and receipts persist in private SQLite. After sleep, daemon restart or plugin reload, the adapter reconnects and resumes never-dispatched signals. A leased claim is recorded before sending. Claimed or uncertain signals are never automatically resent: the adapter checks the recipient's latest timeline and a bounded range after its saved pre-send position, retries delayed reads briefly, and checks Paseo's durable receipt. Missing evidence leaves the signal visibly uncertain. Re-registering does not clear it. Older host registrations migrate when their original Paseo daemon connects; historical uncertainty remains explicit.

The event is `<tether-turn path="ABSOLUTE_PATH" document-id="UUID" signal-id="UUID" />`, preceded by captured annotations. Paseo displays a Tether document chip. Sends carry `messageId: signalId`; completion uses the current host snapshot and matching recipient input, rather than trusting potentially repeated or null turn IDs. The adapter follows the composer's last synchronized `steer`, `interrupt` or `queue` setting, using `steer` before a setting is supplied. Queue waits for idle; the API's final race guard is `steer`. Permission requests and archived/missing agents remain visible, and host events restore availability without model polling.

The startup connection uses the installed Paseo CLI connector and SDK because the current plugin context only provides its API inside callbacks. This compatibility seam is verified against Paseo 0.11.4; the relevant 0.11.2 source contracts are unchanged. No credentials are sent in URLs or CLI output. Folio's separate polling is unchanged.

Annotations are captured at press time, so later drafts stay for the next send. Batches use capture → dispatch → accepted. Acceptance removes only captured drafts, leaving newer annotations untouched. The open composer refreshes its private-store state. A failed/uncertain send retains the batch; **Check acceptance** in Paseo reconciles using the message ID and durable receipt. No uncertain batch is resent automatically.

Hosts without persistent delivery use the watcher fallback; an existing host registration remains authoritative. The CLI confirms a parsed result through `/control/turn/received` before clearing its captured annotations; a lost response leaves the batch retained. The receipt is idempotent and survives daemon restart. A receipt failure still returns the turn and feedback with `annotationWarning`, without resending. `wait` returns `{turn: {signalId, cursor, sequence, requestedAt, path, agentId}, annotations?}` for a press newer than `--after`; without `--after`, it waits for the next press. Without `--timeout`, it waits indefinitely; timeout returns `{turn: null, cursor}`. Re-arming with the returned cursor ends a watcher-delivered turn. Watcher-only agents disappear after 60 seconds without a wait, or after two hours without a re-arm following a press. Watcher cursors name the daemon instance; old-instance cursors count as no presses seen. Watchers reconnect after a restart. A deliberate stop returns `{turn: null, stopped: true}` without restarting Tether.

## Read and save a document

Create a new document in an existing directory with one command:

```sh
tether document create /path/to/new.md --body-file /tmp/draft.md
```

In a local Paseo agent session, this also registers its Go button and adds the document to Folio without opening a view or sending a turn. It reuses the creator’s stable role, including after takeover. A new role gets a title-derived name, an available icon and the next color; optional `--name` and `--icon` override defaults only for a new identity. The response includes the identity to use for `--actor`, registration and review context, just like `turn assign`. No separate registration command is needed.

Creation refuses existing files, symlinks and retained Tether records, including missing files with an existing record. A disconnected Paseo adapter fails before file creation. If later setup fails, `created: true`, `outcome: partially_applied`, warnings and `resume` arguments explain what remains; preserve the created file and finish assignment with the same CLI/profile. After a lost response, inspect `document read` and `turn status` before doing anything else; repeating creation never overwrites a file. Outside Paseo, creation succeeds with explicit unassigned Go status. Shared connections are not supported for creation; use a local profile on the file machine. Opening, importing or adding an existing file to Folio never claims its creator role.

Use `document context`, `outline`, or `diff` to read just what you need. When you need the full body and its revision, use `tether document read /path/to/doc.md`. Save a replacement body with:

```sh
tether document save /path/to/doc.md --expected-body-revision BODY_REVISION --body-file /tmp/revised.md
```

Pass the `sha256:` revision you read; Tether rejects a save if it's stale. If you're unsure whether a save succeeded, check the current body and revision before retrying.

## Shared profiles

See [shared-profile setup](../guide/shared-profile.md) for owner enrollment, client pairing, connectors, and supervised startup. Shared commands take `--connection <private-credential-file>`; use `id:<document-uuid>` for existing documents or a path with `--machine <machine-uuid>` to register a file on that machine. Credentials never belong in a document URL.

[Tether Fly setup](../guide/fly-setup.md) describes the agent-assisted route. `remote bind --connection FILE --receiver CLIENT_ID` persists a profile’s hub connection for existing and new sessions, without a local library; explicit connection flags override it. The receiver is the Paseo plugin client. Use `--workspace WORKSPACE_ID` for existing sessions; new Paseo sessions receive that route automatically. Registration and `delivery` are separate results: missing receiver/workspace routing leaves a public browser link and `delivered:false`.

`remote pair` accepts `--machine-name NAME --qualify-paths yes|no` and `--machine RETAINED_ID`. `remote complete --connection FILE --wait 300` polls approval and safely recovers a lost response against the same private file. `remote setup` and `remote report` use a separate expiring reporting capability; reports cannot approve clients or certify completion. `shared manage ACTION --input JSON` is local-owner management for setup, machine metadata, explicit client association, password creation and revocation. Never put credentials or passwords in shell history; browser Settings provides those inputs directly.

`relocate prepare --output DIRECTORY --destination NAME --attempt SETUP_ID --confirm`, `relocate release --output PRIVATE_RECEIPT --confirm`, and `relocate activate --receipt PRIVATE_RECEIPT --confirm` implement a fenced cutover. `relocate rollback --confirm` is allowed only before source release. Restore uses `restore --source BACKUP --directory NEW_CONFIG`. Consult the setup guide before transferring an authority.

Shared saves also require `--expected-location-version` from the preceding read. Keep both original revisions and the attempted text after an uncertain response:

```sh
tether document save id:DOCUMENT_ID --connection CONNECTION_FILE --expected-body-revision BODY_REVISION --expected-location-version LOCATION_VERSION --body-file /tmp/revised.md
tether document verify-save id:DOCUMENT_ID --connection CONNECTION_FILE --expected-body-revision BODY_REVISION --expected-location-version LOCATION_VERSION --body-file /tmp/revised.md
```

Verification waits behind earlier connector work and reports `matches_edit`, `matches_base`, or `diverged`; it does not replay the save. Retry explicitly only when the current file still matches the original base. A relink changes the location version, so reopen before editing the replacement location.

`document history id:DOCUMENT_ID --connection CONNECTION_FILE` reads historical reviews even when the file machine is unavailable. Use `--thread THREAD_ID` for messages, `--continuation TOKEN` for the next page, and `--limit` / `--max-bytes` for bounded output. These responses have no current body or anchor context.

`document relink id:DOCUMENT_ID DESTINATION --machine MACHINE_ID --connection CONNECTION_FILE` verifies an accessible replacement location and preserves reviews. It refuses a location already associated with another document. Archived destinations require explicit restoration before a new reader opens them; registration accepts `--restore` for that choice. Managed file moves remain local operations.

## Register finished documents

```sh
tether recents add /path/to/doc.md
```

This adds the document to Folio and synchronizes the applicable host without opening a view. Running `tether recents` alone opens Folio. Use `tether folio list` to check which documents are registered.

For local embedding, `tether folio --url` (also `tether recents --url`) returns `{url, expiresAt}` in the usual result envelope without opening a view or starting a host bridge. `--host` selects the target for subsequent document opens; focus flags have no placement effect with `--url`. The URL contains a one-use launch ticket, valid for 30 seconds: consume it immediately and do not log or persist it. Its redirect establishes a scoped browser cookie; the final Folio URL requires that cookie to work.

## Folio and file operations

Conversations have stable document IDs; local commands also accept canonical file paths. If you move a file outside Tether, reconnect its conversation through Folio's Locate action. Tether treats annotation footers already in a Markdown file as file content; it doesn't import their comments.

Use `folio list --view active --open-threads` to find active entries with open conversations. Omit `--view active` to include archived entries. Focused help lists directory and repository filters and sort options. Address documents by path, since positions in the recent list can change.

Use `folio add` to register files without opening a reader. Registration alone doesn't grant browser access; `open` creates a browser session for that document. Archiving hides an active item and keeps its conversation indefinitely by default. Expiry is optional, and restoring an item cancels it. Conversation deletion and retention remove private review data while leaving Markdown files in place.

Use `tether document move <source> <destination>` when you know a document is active in Folio and want to move it with its conversation. You don't need to check Folio before ordinary file moves or handle archived documents specially.

The move command needs an existing Tether record and an unused Markdown destination on the same filesystem. The destination's parent directories must already exist. If you're unsure whether the move succeeded, check both paths and Folio before retrying.

```sh
tether folio export /path/to/doc.md --output /path/to/review.tether
tether folio import --package /path/to/review.tether --directory /path/to/imports
```

Exports refuse an existing destination unless you pass `--overwrite`, which allows atomic replacement. Import results tell you which items succeeded and which failed. Fix failed destinations and retry the same package and directory. Saved receipts let Tether skip successful imports, even if you've since edited or removed those files. Receipts follow moved conversations and expire when their document records are deleted.

Check registry and host registration results separately from file and import outcomes. Use `folio sync` to retry host synchronization without repeating the registry change. Its status distinguishes unsupported, skipped, succeeded, and failed operations.

## Agent skill updates

Use `tether skills list` to find pending skill reviews and `tether skills read ID` to read the installed and proposed instructions, their `sourceRevision`, and the merge prompt. See [agent setup](../guide/agent-setup.md#skill-updates) for the review choices.

After the user approves the merged instructions in your conversation, apply the candidate with:

```sh
tether skills merge ID --expected-revision SOURCE_REVISION --body-file /path/to/merged-skill.md --confirm
```

The command checks that the installed and proposed instructions still match the source revision, installs the merge, and clears the review notice. If either source changed, read and compare again; renew approval if the resulting merge changes. Do not bypass a conflict by substituting a fresh revision without reviewing it.

## Profiles and failures

The default profile is `preview`, with `default` as an alias. Use the same `TETHER_PROFILE` value across commands when isolating work. The `TETHER_CONFIG_DIR` and `TETHER_RUNTIME_DIR` overrides name the exact private directories, not just profile names.

Stdout contains one protocol-v1 JSON envelope. Check `ok`, the exit code, individual item results, and warnings. An error can arrive after some work has succeeded. See [protocol details](protocol.md) for pagination, diagnostics, mutation receipts, and durability limits.

## Workspace recovery and startup

- `tether resume --inspect`: list existing cmux panes that would be reloaded, without starting a stopped daemon or navigating.
- `tether resume`: start the service, attach cmux, and reload existing Tether panes that show an error page, using their saved cookies.
- `tether startup status`: report whether login startup is enabled and loaded, whether the daemon is running, and whether cmux is attached. Starts nothing.
- `tether startup enable`: start Tether at login for the current packaged installation, and write the cmux shell hook. Safe to repeat.
- `tether startup disable`: remove the login job and the shell hook. Running processes keep running; `tether daemon stop` stops them.
- `tether cmux attach`: entry point for the shell hook. Starts the service if needed and attaches this cmux terminal's authority.

See [recovery](../guide/recovery.md). Tether never edits your shell startup files.

## Paseo plugin channel (experimental)

The Tether plugin for Paseo uses these commands. Paseo can't be driven from outside, so Tether queues each open as an *intent* and the plugin pulls it. The commands and their data shapes may change between releases.

- `tether paseo status`: report whether a plugin is connected (`present`) and how many intents are pending. It never starts the service.
- `tether paseo wait [--after <cursor>] [--folio <version>] [--timeout <seconds>]`: return intents newer than `--after`. It returns early when an intent arrives or Folio changes past `--folio`. The timeout is at most 25 seconds. A wait marks the plugin connected for 30 seconds.
- `tether paseo ack <intent-id>...`: remove intents the plugin has handled. An unacknowledged intent expires with its launch ticket.
- `tether paseo theme <client-id> <theme-id|unknown>`: report the mounted desktop client’s palette for optional theme inheritance. The client ID is a persistent UUID, not an authorization token; unknown palettes preserve the last inherited theme.

Inside Paseo, `tether open` picks the `paseo` host automatically when the plugin is connected, or explicitly with `--host paseo`. Opens that the plugin makes for the user open a reader tab. Any other open, such as an agent's, only lights the workspace's Tether button and reports `notified: true`, so Tether never moves your focus. `tether recents add` does the same inside Paseo and reports `announced: true`. Links clicked in a Paseo reader open as new tabs directly from the reader.

### Chat annotation storage

`tether paseo chat <json-file|->` is the plugin’s internal storage channel. A request contains `host`, `agent` and `operation`; `-` reads bounded JSON from stdin. It calls the authenticated Tether daemon, which alone owns the chat tables in its private SQLite database. The result is `{ drafts, submission }`.

Operations are `read`, `save` (draft), `remove` (draft ID), `capture` (batch ID, prose, attachment metadata), `dispatch` (batch ID, native message ID, text, wire options), `accepted` (matching batch/message IDs), `cancelPrepared` (batch ID) and `deleteChat`. Captured drafts are immutable; dispatch precedes transport, and acceptance deletes only that batch. `cancelPrepared` rejects uncertain delivery. `deleteChat` is reserved for confirmed permanent chat deletion and fences subsequent stale writes. Validation and state conflicts return `chat_state`. Requests are scoped by daemon and agent, independently of document paths and review ledgers.

## Installer setup

`tether setup --no-open` reports host discovery, update-channel configuration, and optional integration guidance while preserving focus. A configured update channel is not a live connectivity check; use `tether update --check` for that.

`--agent-directory /absolute/skills` keeps its existing review-skill behavior. Add `--skills tetherball` to accept both skills, or `--skills tether-review,tetherball` explicitly. Setup reports `agents` with each identity/path/result and retains the legacy `agent` field for the review skill. Neither skill is installed without the directory flag.

The installer runs `tether setup --release-notes`, which also copies the current release notes into Tether's documents folder, adds them to Folio, and opens them after the welcome guide. The optional Tetherball offer appears only in that release-notes reader.

`--paseo` accepts installation of the packaged plugin into the local Paseo daemon. It preserves unmanaged installations and the global plugin switch. `hosts` distinguishes installation, version, active environment, and known connection state; `null` means a connection was not probed. `warnings` reports optional integration steps that need attention even when core setup succeeds.

## Visual evidence

`tether visual <file> <thread-id> [--mode overview|crop|clean] [--offset <count>] [--history <index>]` retrieves a private PNG artifact. The default overview contains at most 12 numbered regions, with a longest side of 1200 pixels. `regions` maps each number to `threadId`, a bounded comment excerpt and the normalized `{x,y,width,height}` rectangle. Grouping uses block occurrence and saved visual revision, not image content alone. `nextOffset` is null at the end of the group. `--history 0` retrieves the oldest retained anchor for that thread.

The result includes `status`, `artifact` (an absolute local path), `mimeType`, `mode`, `visualRevision`, `evidence`, original `width`/`height`, `attachment` and `verification`. `attachment` is `located`, `stale` or `orphaned`; `verification: unverified` explicitly distinguishes a saved capture from a verified current rendering. Load `artifact` using the agent's image tool. Use `--mode crop` for the selected pixels or `--mode clean` for the unmarked base visual. No detail derivative is generated by `pending`, `thread`, or the default overview. Missing evidence and invalid or oversized exports return errors.

The browser's annotation endpoint also accepts `type: reanchor`, with `threadId`, `anchor`, `expectedBodyRevision`, `expectedThreadSequence` and `operationId`. It retains the original comment and derives the effective anchor from subsequent events. Visual creation and replacement additionally require `evidenceData` (base64 PNG) and `currentVisualRevision`; local image anchors carry the revision recorded when their pixels were served. Evidence and the event commit in one private-store transaction. A stale body, thread sequence or loaded local-image revision rejects the mutation; operation receipts make retries idempotent.

Visual anchors extend quote locators with a versioned `visual` record: kind, source identity, original occurrence count, layout revision, evidence hash, pixel dimensions, optional SVG viewBox and normalized rectangle. Package version 2 carries retained events and their referenced evidence; version 1 remains supported for text reviews. Unknown package versions and visual-anchor versions are rejected.
