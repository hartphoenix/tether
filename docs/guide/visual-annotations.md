# Commenting on images and diagrams

Choose **Comment** in an image or Mermaid diagram’s hover controls to open the viewer in region-selection mode, then drag a rectangle. You can also choose **Comment** inside the viewer. Write your comment in the viewer and submit it. Tether saves the clean visual and the selection together in private review storage; the Markdown file stays unchanged.

Escape cancels a selection before closing the viewer. Cancelling or failing to save preserves the existing thread. If the document or visual changes while you compose, cancel and select again. Pending document edits must save successfully before selection begins.

Each saved region appears as a translucent rectangle in the theme's annotation color, with a badge counting the initial comment and its replies. Clicking it opens that thread. Regions appear in the reader and expanded viewer. The viewer’s drawer contains only threads attached to that image or diagram, with the selected thread expanded. Click a card to expand or collapse it; **Hide threads** closes the drawer. Threads use the usual reply, resolve and reopen controls. Resolving a thread hides its card and region unless resolved threads are included in the document drawer. Closing the viewer also closes its drawer.

When the visual changes, a badge above its block provides access to earlier comments. The viewer labels the region **Region from an earlier version** and offers a subtle **Redraw selection** action. This action stays hidden for unchanged visuals. Redrawing keeps the thread, its messages, resolution state and previous anchors. Missing or ambiguous blocks remain in the orphaned-thread list; agents can retrieve their saved evidence with the CLI below.

For an orphaned text thread, choose **Reselect text**, then select a nonempty passage in the same document. Escape or clicking the active button cancels reattachment.

## Capture availability

Local images, directly exportable remote images and Mermaid diagrams support region comments. Remote images try a CORS-approved load when first displayed. If that fails, ordinary image viewing remains available, but browser security may prevent region capture. Tether reports that limitation in the viewer before submission. Commenting never retries the remote image through a proxy, screenshot or screen-sharing prompt.

Capture is limited to 4096 pixels on either side, 8 million pixels in total and an 8 MiB PNG. Oversized images remain viewable. Mermaid exports include computed styles and embedded web fonts; inaccessible fonts and diagrams containing embedded images or HTML cannot be captured. Selection is designed for desktop Chromium and WebKit; touch interaction has not been validated.

## Agent inspection

Start with `pending` and `thread`, then request a visual overview:

```sh
tether visual /absolute/path/document.md THREAD_ID
```

The response includes an absolute PNG `artifact` path and a numbered manifest. **Load that path with the agent's image/vision tool**: JSON containing a filename does not itself show the image to the agent. Numbers identify stable thread IDs and normalized rectangles. The overview contains at most twelve regions from the same block occurrence and saved visual revision; use `--offset` with `nextOffset` for additional groups.

For more detail, request only what is needed:

```sh
tether visual /absolute/path/document.md THREAD_ID --mode crop
tether visual /absolute/path/document.md THREAD_ID --mode clean
tether visual /absolute/path/document.md THREAD_ID --history 0
```

History indexes start at zero, with the oldest retained anchor. Evidence remains available after the viewer closes or the daemon restarts. `verification: unverified` means the daemon cannot establish that the current rendered visual matches the saved capture; it does not mean that the saved evidence is missing. A known source change is reported as stale, separately from a missing block.

Review packages containing visual comments or reattachment history use version 2. They retain referenced evidence and the history of exported open threads. Older readers reject version 2 packages; existing text-only version 1 packages remain accepted.
