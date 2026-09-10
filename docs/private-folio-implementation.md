# Private review storage and Tether Folio

Tether now keeps Markdown and review data separate. New review operations do not add annotation data to Markdown. Comments, replies, acknowledgement cursors, Folio state, and reader recovery state live in one private SQLite database.

## Identity and storage

A document conversation is identified by its canonical absolute path. Opening the same path reconnects its conversation. Copying a file to another path starts a separate conversation. Moving or renaming a file breaks the association until **Locate file** reconnects the old Folio entry to the new path. Locate refuses to merge two existing conversations.

On macOS, the normal database is:

```text
~/Library/Application Support/tether/config/preview/tether.sqlite
```

Normal launches and the historical `default` profile both map to the existing `preview` configuration location. Explicit `TETHER_CONFIG_DIR` and `TETHER_RUNTIME_DIR` overrides remain available for isolated development and tests. The existing `recent-files.json` is imported once into Folio; theme preferences remain in `preferences.json`.

There is no automatic migration for old embedded annotation ledgers. Old ledgers are left untouched; their annotations are not loaded into the new conversation store.

## Folio

Folio is a 

Double-click `Open Tether.command` in the checkout, or open Folio with:

```sh
./mdreview folio
```

Folio has **Active** and **Archive** views. It shows missing files and supports title/path filtering, needs-attention and missing-file filters, pinning, and sorting by recent open, document modification, conversation activity, addition, file creation, or name. Entries can be grouped by directory or Git repository.

Clearing moves an active entry to Archive and never deletes the Markdown file. Pinned entries survive **Clear unpinned**. Reopening an archived entry returns it to Active and cancels expiry. **Locate file** repairs a moved file association.

Archive retention defaults to Keep forever. A positive number of days or Delete immediately is an explicit opt-in. Old deadlines from the implicit 30-day default are cancelled when the new registry opens; explicit retention choices remain intact. Changing the setting recalculates expiry from each entry's original clearing time. Expiry removes the Folio record, conversation, and recovery data; it never removes the Markdown file.

Common commands:

```sh
./mdreview folio list --view active --sort activity --needs-attention
./mdreview folio add notes/one.md notes/two.md
./mdreview folio pin notes/one.md
./mdreview folio pin notes/one.md --off
./mdreview folio archive notes/two.md
./mdreview folio restore notes/two.md
./mdreview folio locate old/path.md --new-path new/path.md
./mdreview folio settings
./mdreview folio settings --retention 14 --confirm
./mdreview folio settings --retention forever --confirm
./mdreview folio settings --retention immediate --confirm
```

`--confirm` is required when changing retention. It is also required when archiving under Delete immediately.

## Export and import

**Export with annotations** creates a versioned JSON review package containing each selected document's current Markdown body and unresolved conversations as displayed. It includes comment and reply authors, timestamps, bodies, and anchors. It excludes absolute source paths, resolved or deleted material, raw event history, drafts, and acknowledgement cursors.

```sh
./mdreview folio export notes/one.md notes/two.md --output review.tether
./mdreview folio import --package review.tether --directory imported-review
```

Import validates the package, confines files to the chosen directory, and refuses to overwrite an existing file or conversation. Imported files are added to Active Folio.

## Agent review workflow

Review-event mutations require a caller-supplied operation ID. Reusing an operation ID with the same request safely returns its prior result; reusing it for different content fails. Reply, resolve, and reopen can also require the latest thread sequence to prevent a stale mutation.

Start with a compact pending read:

```sh
./mdreview pending notes/one.md --actor assistant
```

The response contains an opaque `cursor`. Fetch only the needed thread, then mutate with the thread's returned sequence:

```sh
./mdreview thread notes/one.md <thread-id>
./mdreview reply notes/one.md <thread-id> \
  --actor assistant \
  --body-file reply.md \
  --operation-id reply-001 \
  --expected-thread-sequence <sequence>
```

Create an anchored comment from an exact, unambiguous rendered-text quote:

```sh
./mdreview comment notes/one.md \
  --actor assistant \
  --quote "exact passage" \
  --body-file comment.md \
  --operation-id comment-001
```

After handling the pending events, acknowledge the exact cursor returned by `pending`:

```sh
./mdreview acknowledge notes/one.md \
  --actor assistant \
  --cursor <cursor> \
  --operation-id ack-001
```

`threads` provides paginated conversation discovery. `thread` provides one thread. `resolve` and `reopen` use the same operation-ID and optional expected-sequence pattern as `reply`. Acknowledgement is consumer-specific when `--consumer` is supplied and remains separate from resolution.

## Restart and implementation handoff

The SQLite store also retains browser view authorization verifiers, drafts, and scroll positions. A controlled restart returns on the same loopback port, reconstructs document and Folio sessions, and lets open pages reconnect with their existing scoped cookies. Folio recognizes the new daemon instance and accepts its restarted event sequence. **Restart service** and **Quit Tether** are available from the Folio menu.

The main boundaries are:

* [`PrivateStore`](../src/storage/private-store.ts): owns `tether.sqlite`, document rows, review events, cursors, mutation receipts, and settings.
* [`DocumentService`](../src/documents/document-service.ts): owns path-scoped file access, clean body reads/writes, private review operations, and package validation.
* [`RecentsRegistry` / `RecentsService`](../src/recents/registry.ts): retain compatibility names while owning Folio membership, metadata, retention, expiry, publication, and host launcher synchronization.
* [`ViewStore`](../src/server/view-store.ts): persists reader/Folio sessions, drafts, and positions without storing bearer cookies.
* [`folioHtml()`](../src/web/folio-page.ts): standalone browser UI over scoped Folio HTTP routes.

Folio mutations commit even if host launcher synchronization fails. The result reports `hostSynchronized: false` and a `hostIssue`; the durable Folio update is not rolled back. Expiry and conversation-only refreshes do not synchronize host launchers because the active launcher list has not changed.

## Verification

The complete check passes: 209 tests, TypeScript, and the production web build. Regression coverage includes restart authorization, draft recovery ordering, repeated conflicts, operation retries, import collisions, archive expiry, and deletion races. Native Finder/Wave interaction has not been manually exercised in this build.
