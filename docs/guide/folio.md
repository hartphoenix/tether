# Folio and sharing

[Documentation](../README.md) · [Host setup](hosts.md)

Folio is Tether's document organizer. It keeps active projects together and shows which documents have open conversations. Run `tether folio` to open it, or use your host's shortcut: the Tether button in Paseo, the Dock in cmux (`⌘-⌥-B`), or the **Tether Folio** widget in Wave. [Host setup](hosts.md) describes each one.

## Mobile Folio

In the phone reader, the folder button at the top right opens Folio beside the document. It follows the reader’s theme and shows Active and Archive, text filtering, sorting, pins and conversation counts. Selecting an available document closes the drawer and opens it in the same tab. Mobile comments belong to the same conversation as desktop comments.

The mobile drawer has no custom context menu, document-link hover effects, file picker, annotation import, Quit, or service restart. Restart remains a host operation: it disconnects every phone session. The toolbar uses solid backgrounds without blur.

Desktop library access must be explicitly enabled when configuring the phone reader; the single-document pilot remains scoped to its test document otherwise. See [phone reader setup](../contributing/phone-reader.md).

## Toolbar

* **Active** lists ongoing work, and **Archive** holds documents you've finished with. Clicking an archived document restores it to Active.
* **Filter** (funnel icon) saves searches that match file paths, file names and each document's first H1 heading. A project folder's name makes a useful filter.
* **Sort** (slider icon) orders documents by when they were opened, modified, added to Folio or created, by recent conversation activity, or by name. It can also group them by directory or Git repository.
* **Folio menu** (three lines icon) has **Select documents**, **Import annotations**, **Settings** and **Check for updates**, along with **Restart service** and **Quit Tether**.

**Select documents** lets you pin, archive, restore or export several documents at once.

## Settings

**Interface scale** sizes the application controls, and **Comment text** sets the size of conversation text, starting at 16px. Both apply to every reader in the current Tether profile; the threads drawer's zoom button has the same two controls. **Default document zoom** sets the scale for newly opened documents.

**Archive retention** defaults to **Keep forever**. You can instead keep archived conversations for a number of days, or choose **Delete immediately**. When an archived entry expires, Tether deletes its conversation and recovery data and leaves the Markdown file alone. Restoring a document to Active cancels its expiry.

## Document actions

Right-click a document in Folio for these actions:

* **Pin** keeps the document at the top of the list.
* **Copy file path**, **Reveal in Finder** and **Open in Default App** work with the Markdown file.
* **Export with annotations** creates a `.tether` package; see [Sharing](#sharing).
* **Archive** moves the document to Archive, and **Restore to active** brings it back.
* **Remove from Folio** appears for documents without a conversation and removes their entry.
* **Delete conversation** permanently deletes the document's threads and leaves the Markdown file alone.
* **Move file to Trash** moves the Markdown file to the macOS Trash and archives its Folio entry, so the conversation follows your archive retention setting.
* **Locate file** appears when a document with a conversation has moved outside Tether; Folio shows its title in red. Choose the file's new location to reconnect the conversation.

Agents moving an active document should use `tether document move`, which carries the conversation with the file.

## Sharing

Tether stores comments apart from your Markdown files, so sharing a file alone doesn't share its conversation. **Export with annotations**, in the reader or Folio, creates a `.tether` package containing the document body and its open threads, with authors, timestamps and anchors. The package leaves out resolved and deleted threads, event history, drafts, acknowledgement cursors and absolute source paths.

To add a package from another machine or profile, choose **Import annotations** in the Folio menu and pick a destination directory. Tether won't overwrite existing files or conversations, and it adds imported documents to Active. If some items fail, fix their destinations and import the same package into the same directory again; Tether skips items it has already imported.

The [CLI reference](../reference/cli.md#folio-and-file-operations) lists command-line equivalents. To keep your complete private history, make a [backup](recovery.md#back-up-and-restore).
