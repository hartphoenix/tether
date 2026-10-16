# Visual annotation implementation

The [user guide](../guide/visual-annotations.md) describes selection and agent retrieval. The [CLI reference](../reference/cli.md) defines the transport.

`src/web/visual-selection.ts` owns the SVG overlay and viewer composer. Pointer events map through the SVG inverse screen transform (including viewBox origin), or the displayed image rectangle. Painting is scheduled once per animation frame. Capture, hashing and network operations happen outside the gesture loop. A transform change cancels an unfinished draw.

`src/web/visual-capture.ts` captures loaded pixels. Mermaid exports normalize mounted IDs, inline computed styles and embed font resources before rasterization. Source, layout and PNG evidence hashes serve separate purposes. The renderer and its ID isolation remain unchanged. Remote images attempt CORS during initial display loading in `image-url.ts`; capture never refetches the image.

`src/core/visual-anchor.ts` validates normalized regions. Quote context and projection position identify block occurrences; the original match count prevents a surviving duplicate from silently inheriting a removed occurrence's thread. Reanchor events retain original comments and prior effective anchors. Agent context reads query the latest anchor event, rather than the initial comment.

`src/documents/visual-evidence.ts` stores bounded PNGs in `visual_evidence`, keyed by document ID and SHA-256. An additive SQLite table requires no rewrite of existing events. Evidence and its referring event commit in the same transaction. Conversation deletion removes evidence and that document's derivative directory. Reanchoring retains old evidence. Packages with reanchor events or visuals use version 2 and import their evidence in the same transaction as the conversation.

`visual-png.ts` handles bounded non-interlaced, 8-bit RGB/RGBA PNG evidence. It verifies chunk checksums and bounds inflation before decoding. The base pixel plane is at most 32 MB; decode uses separate filtered and reconstructed buffers, so allow roughly 128 MB of transient working memory for a maximum-sized capture. Snapshot sides are limited to 4096 pixels, total area to 8 million pixels and encoded evidence/artifacts to 8 MiB. Overviews fit within 1200 pixels and include at most 12 regions and 1000 characters per comment. Detail crops are generated only on request. SVG capture is limited to 10,000 elements and 16 MiB of serialized styled SVG. Font capture is bounded to 2 MiB per resource and 8 MiB cached; initial remote-image loading caches at most 32 sources and 64 MiB of image bytes per document.

The daemon does not recreate browser layouts. It reports saved evidence as unverified when it cannot verify the current rendering. A loaded local image's source hash is checked again at mutation time, including changes without Markdown edits. Direct client capture checks the selected layout again before submission.

Run:

```sh
bun run check
bun run check:geometry
bun scripts/check-markdown-rendering.ts
bun scripts/check-visual-capture.ts
```

The visual tests cover geometry validation, evidence durability, receipts, conflicts, retained anchors, package round trips, text reattachment, direct capture and browser selection. No publisher or release operation is required.
