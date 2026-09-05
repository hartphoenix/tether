# Adding files to Tether Recents

_Research note, 2026-09-05_

## Decision

Implement the **+ picker** on macOS. Drag and drop is not part of the product design.

Tether Recents stores canonical paths to existing documents. A normal web page receives a selected or dropped file's name, metadata, and contents, but not its absolute path. Uploading the contents would require Tether to create and queue a copy; it would no longer track the file the user dragged.

## + picker

Have the Recents page ask the local Tether daemon to open a macOS `NSOpenPanel`. This avoids dependence on the embedding browser and therefore behaves the same in cmux, Wave, and a system browser.

The panel should:

- allow multiple files but no directories;
- enable only `.md` and `.markdown`;
- label its action **Add Files**;
- return paths only after explicit user confirmation.

The daemon should then canonicalize and validate every path, update the queue once, synchronize the host once, and return the refreshed list. Cancellation should do nothing and show no status message. Concurrent picker requests should be rejected while one panel is open.

Keep this behind an injected platform service such as `pickMarkdownFiles()`, not in the Recents registry or a host adapter. The picker is an OS capability; cmux and Wave only contain the page. Expose availability to the Recents page and hide the **+** button where no platform implementation exists.

Implementation:

1. Launch AppKit `NSOpenPanel` through the system JavaScript automation runtime, avoiding a compiled helper or new dependency.
2. Add an authenticated, same-origin `POST .../api/pick` route. It accepts no browser-supplied path.
3. Add `RecentsRegistry.addMany()` plus a batch service operation so validation and the registry write occur once and host synchronization occurs once.
4. Put **+** beside **Select**. Disable it while the panel or queue update is active; on success show `Added n files.` for the existing ten-second status interval.
5. Test cancellation, multiple selection, aliases, duplicate paths, a file disappearing before commit, picker re-entry, and host-sync failure with an injected fake picker.

## Sources

- [Apple `NSOpenPanel`](https://developer.apple.com/documentation/appkit/nsopenpanel)
- [Wave's public web-widget contract](https://docs.waveterm.dev/customwidgets)
- [cmux browser automation and surface contract](https://cmux.com/docs/browser-automation)
