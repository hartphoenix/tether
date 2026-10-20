# Writing and formatting

[Documentation](../README.md)

Tether edits ordinary Markdown files. It saves every change to the document body in the file itself, and it follows CommonMark and GitHub Flavored Markdown with a few gaps, listed under [Supported Markdown](#supported-markdown).

## Editing

- **Selection menu.** Select text to apply inline formatting or leave a comment.
- **Insert menu.** Right-click in the document to insert lists, images, tables, code and math blocks, blockquotes, horizontal rules and footnotes. The top toolbar also has **Footnote**.
- **Markdown source.** **Edit Markdown source** in the toolbar switches to plain text, including frontmatter. Source edits keep exactly what you type and get the same autosave, draft recovery and conflict checks as the formatted view. Finish reviewing incoming changes before switching views.
- **Incoming changes.** When an agent or another editor changes the file, Tether shows the new version with each changed passage marked: changed words in a medium weight and color, and a line in the margin. Once Tether records who saved each revision, the color is the author's. Two quick right-clicks or two-finger taps on a change show its earlier wording in place, and repeating them switches back. The change menu identifies its author with a badge and name above the actions; changes without attribution show “Author unknown.” Right-click a change to **Comment** on it, show its earlier wording, **Mark seen** or **Revert this change**; clicking the margin line marks current wording seen or reverts the change when earlier wording is showing. The bar at the top steps between changes, and **Mark all as seen** marks the rest seen, and **Revert all** restores all changes still under review. Changes already marked seen are kept. Reviewing never rewrites the file; only a revert saves.
- **File actions.** The toolbar's **File actions** menu has **Copy file path**, **Reveal in Finder** (where the host supports it), **Move file** and **Export with annotations**. Move keeps the file name, refuses to overwrite another file and keeps the document's conversation attached.

## Supported Markdown

| Feature | In Tether |
| --- | --- |
| Headings, emphasis, lists, quotes, links, code | Supported |
| Tables, task lists, strikethrough | Supported |
| Footnotes | Supported; definitions open in a popover |
| Math | Supported, inline and in blocks |
| Mermaid diagrams | Supported |
| Local and remote images | Supported, with limits below |
| GitHub alerts such as `[!NOTE]` | Shown as ordinary blockquotes |
| Definition lists | Shown as ordinary text |
| Raw HTML, such as `<sub>`, `<kbd>` and `<details>` | Shown as literal markup |

For an alert, use a blockquote that starts with a bold label. For definitions, use a list or a table.

Because `$` starts inline math, write a literal dollar sign as `\$`, as in `\$20`.

## Links

- `[Section](#section)` links to a heading in the same document.
- `[Section](other.md#section)` links to a heading in another document.
- `[[other.md|Label]]` is a wikilink to another document.

Paths are relative to the file containing the link. Heading anchors follow GitHub's rules, so changing a heading's text changes its anchor.

## Images

Write image paths relative to the Markdown file; `../` and URL-encoded spaces both work. Tether displays PNG, JPEG, GIF, WebP, AVIF and SVG images up to 32 MiB. Absolute file paths don't work. A newly inserted local image appears once the document has saved. Remote image URLs load as they would in a browser.

Pinch an image to open it in the zoom viewer.

## Diagrams

Tether renders Mermaid diagrams locally with [Pele](https://pele.run), using your theme's colors and reading font. Diagrams lay out again for narrow screens instead of shrinking, and on wide screens they can extend past the text column. Hover or tap an element to highlight what it connects to. To use the Mermaid library instead, add `diagrams: mermaid` to the document's frontmatter. **Edit** shows a diagram's source, and an invalid diagram shows its source in place of the drawing. To expand a diagram, choose **Zoom** or pinch it. In the viewer, pinch or use the zoom buttons to zoom, scroll to pan, and press Escape or **Close** to return to the document.

## Footnotes

Footnotes are numbered in the order their references appear. When you insert one, Tether asks only for the note's text; it places the reference after any selected text, or at the cursor, and adds the definition at the end. Each footnote keeps a stable identifier in the Markdown, such as `[^note-a7c2d019]`, so inserting an earlier note renumbers the display without breaking any references.
