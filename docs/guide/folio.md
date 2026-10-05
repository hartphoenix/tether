# Folio and sharing

[Documentation](../README.md)

## Current review

The Mobile Folio section describes the new phone drawer and its available controls. No desktop behavior changes.

Run `tether folio` to open the document organizer. In cmux, you can add it to the Dock (right sidebar) in **Settings > Beta Features**, then use  `⌘-⌥-B` to show/hide it. Folio keeps active projects together and helps you find documents and conversations that need attention.

## Mobile Folio

In the phone reader, the folder button at the top right opens Folio beside the document. It follows the reader’s theme and shows Active and Archive, text filtering, sorting, pins and conversation counts. Selecting an available document closes the drawer and opens it in the same tab. Mobile comments belong to the same conversation as desktop comments.

The mobile drawer has no custom context menu, document-link hover effects, file picker, annotation import, Quit, or service restart. Restart remains a host operation: it disconnects every phone session. The toolbar uses solid backgrounds without blur.

Desktop library access must be explicitly enabled when configuring the phone reader; the single-document pilot remains scoped to its test document otherwise. See [phone reader setup](../contributing/phone-reader.md).

## Folio Toolbar

**Active** shows ongoing work; **Archive** holds finished conversations.

Use the **Filter** button (funnel icon) to save searches across file paths, file names, and each document's first H1 heading. A project folder's name makes a useful filter.

Using the **Sort** button (slider icon), you can sort by when a document was opened, modified, added, or created, as well as by recent conversation activity or by file name. Group entries by directory or Git repository to keep related work together. 

The **Folio Menu** (three lines icon) has batch selection, import, and **settings**:

**Interface scale** changes application controls; **Comment text** independently sets conversation body text, starting at 16px. Both apply across readers in the current Tether profile. The threads drawer's zoom button exposes the same two controls. **Default document zoom** controls how newly opened documents are scaled.

### Archive retention

Archived conversations default to **Keep forever**. Via **settings**, you can choose a custom retention period or **Delete immediately**; when an entry expires, Tether deletes its private conversation and recovery data but leaves the Markdown file alone.

Restoring a document returns it to Active and cancels its expiry.

Pin documents you want to keep visible. **Clear unpinned** archives all other active documents without deleting their Markdown files.

## Context Menu

**Right-click a document in Folio** for actions on that document:

* **Remove from Folio** will skip the Archive and delete that doc's threads and Tether data, but leave the Markdown file alone.
* **Move file to Trash** deletes associated Tether data and sends the Markdown file to macOS's trash. Restoring it from the trash will not restore its Tether data.
* If you move a file outside Tether, its title will display in red; use **Locate file** to reconnect its conversation data to the new file path. Agents moving an active document should use `tether document move` to carry its conversation with it.

## Export: sharing Tether data

Tether's annotations are kept separate from Markdown files; if you want to share open threads from Tether along with a file, use **Export with annotations** in the reader or Folio to create a `.tether` package containing the document body and open threads, with authors, timestamps, and anchors. (The export package doesn't include resolved or deleted material, event history, drafts, acknowledgement cursors, or absolute source paths.)

To add an export package from another machine or profile, use **Import annotations** in Folio and choose a destination directory. Tether refuses to overwrite existing files or conversations and adds imported documents to Active. If some items fail to import, fix their destinations and retry with the same package and directory. Tether skips items it has already imported.

For CLI equivalents, see [file operations](../reference/cli.md#folio-and-file-operations). For complete private history, use a [backup](recovery.md#private-review-backup).
