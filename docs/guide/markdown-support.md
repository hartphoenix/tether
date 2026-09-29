# Markdown rendering

Tether uses Milkdown Crepe with CommonMark and GFM presets. Support for Markdown syntax does not imply support for every feature rendered by GitHub or other readers.

Right-click in the document to open Insert: lists, images, tables, code and math blocks, blockquotes, horizontal rules, and footnotes. Each entry uses its toolbar icon, and the menu follows interface scaling. Inline formatting and comments remain in the selection tooltip; Footnote appears in Insert and the top toolbar.

| Feature | Current behavior |
| --- | --- |
| Headings, emphasis, lists, quotes, links, code | Rendered as editor content |
| Tables, task lists, strikethrough | Supported through the GFM preset |
| Footnotes | Supported; insert from the right-click Insert menu or top toolbar and read definitions in a popover |
| Mermaid diagrams | Rendered through Mermaid 12; Edit exposes the fenced source |
| GitHub alerts such as `[!NOTE]` | Displayed as ordinary blockquotes, without alert styling |
| Definition lists | Displayed as ordinary text |
| Raw HTML, including `<sub>`, `<kbd>`, and `<details>` | Displayed as literal markup, not rendered HTML or interactive disclosures |
| Document-relative local images | Supported for image references in the saved Markdown, including inline and reference-style images |

Local image paths resolve from the Markdown file's directory, including `../` and URL-encoded spaces. Tether serves PNG, JPEG, GIF, WebP, AVIF, and SVG images up to 32 MiB through the document's authorized session. Saved Markdown keeps its original paths. Newly inserted local image references require saving before loading; absolute filesystem image paths are not supported. Remote image URLs retain their normal browser behavior.

For alerts, use a blockquote with a bold label. Definition-list rendering is intentionally unsupported; use a list or table instead.

Footnotes display sequential numbers in reference order. Insertion preserves selected text and appends the reference after it, or inserts at the caret. Definitions stay at the end in matching order. Stable identifiers such as `[^note-a7c2d019]` are saved in Markdown; inserting an earlier note changes displayed numbers without changing these connections. The composer asks only for note content; identifiers are generated automatically, and existing source identifiers are preserved.

Mermaid loads locally on demand when a document contains diagrams. Invalid diagrams retain their source behind Edit. Rendering uses Mermaid's strict security mode and the editor's sanitized preview. Default diagram colors follow the selected reader theme, and labels use its code font. Existing diagrams refresh when theme colors or the code font change, without reopening the document.

Mermaid flowchart labels use SVG text to avoid clipping from editor paragraph styles. Zoom beside Copy/Edit expands a diagram within the current reader. Pinch to zoom and scroll to pan; Phosphor icon buttons provide Zoom in, Zoom out, and Fit, with tooltips and accessible labels. The viewer follows viewport resizing, including host focus/full-screen modes. Close or Escape returns to the document.
