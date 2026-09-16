# Canvas geometry contract and build plan

2026-09-16 · Status: approved for execution; browser topology proof pending

## Outcome

Every document-bound control must track its current source and remain usable throughout Tether's supported 75–175% zoom range, scrolling, viewport changes and document reflow. Placement must not alter Markdown, selection semantics, annotation anchors or highlight painting. Arbitrary positive finite scales inside that range use the same equations; no preset-specific offsets.

The prior audit found competing coordinate conventions, a frozen link-preview anchor, incomplete overlay lifecycles, and viewport lengths assigned directly to local image/table dimensions. This build establishes one geometry contract and removes compensating paths rather than adding another global multiplier.

## Contract

### Coordinate ownership

- Document positions and native ranges identify text; fresh DOM measurements identify its current location.
- All pointer input and rectangles crossing module boundaries use viewport CSS pixels.
- Local CSS lengths are obtained only at a named viewport-to-local boundary, including origin, border, scroll and measured scale.
- No global monkey-patching of DOM rectangle APIs, ProseMirror or CodeMirror.
- Browser page zoom and device-pixel ratio remain browser concerns; application zoom does not multiply either again.

### Canvas scaling

Keep the existing `.milkdown` as an untransformed theme, toolbar and floating-control shell. Wrap only `.ProseMirror` in a stage containing a transform-scaled scene, anchored at top left, with inverse layout width and a stage whose height follows the scene's unscaled border-box height times scale. The scene is absolute; the stage uses `overflow: clip` to exclude phantom unscaled overflow without creating another scroller. Verify that clipping behavior in the supported engines. This uses standard transformed viewport rectangles in modern and older WebKit instead of supporting two CSS-zoom measurement conventions across the entire editor stack.

Leave the sticky toolbar in the existing unscaled `.milkdown` shell with unchanged theme ancestry. Remove reciprocal toolbar zoom and obsolete CSS-zoom height handling. Retain the verified code-block placeholder metrics and at least 20 viewport pixels of scrollbar clearance, including at 75%; remove clearance adjustments only if browser measurements establish they are unnecessary.

The scale owner updates the wrapper through ResizeObserver, coalesces writes, tears down on document replacement, and preserves a visible text anchor's viewport Y during an explicit zoom change. Height updates must not create feedback loops, extra whitespace, or horizontal overflow at either endpoint. Native editing and CodeMirror scale handling must pass browser tests before adopting this strategy.

### Overlay ownership

All free-floating Milkdown tooltips, block handles, slash menus and latex editors target the existing unscaled `.milkdown` shell via their provider root; they must never be children of the clipped stage. Tether-owned dialogs/popovers use an unscaled viewport layer. Keep floating interaction chrome at ordinary UI size while document content scales, matching the toolbar; remove independent annotation-popup zoom. Only embedded image/table controls remain inside the scene and convert viewport lengths to local units. Code-language and table action menus require explicit escape from stage clipping or browser-proven bounds within it; preserve Vue event/focus ownership when portaling.

A small shared overlay controller owns fresh anchor measurement, viewport/canvas collision bounds, update scheduling, hide/disposal, and cancellation of stale asynchronous writes. Its usable bounds exclude the visible toolbar and the open desktop rail, include visualViewport offsets, and limit oversized content with internal scrolling.

Explicit policies:

| Surface | Reference and lifecycle |
| --- | --- |
| Link preview | Live DOM/range source, hovered line fragment; hover transfer preserved; dismiss if removed/offscreen |
| Selection and code toolbars | Live selection range; preserve editor focus while activating actions; dismiss on invalid selection |
| Comment/reply/tag/review forms | Live semantic anchor while valid; preserve entered text/focus and clamp as viewport dialog if source disappears/offscreen |
| Footnote | Live reference element; clamp, follow reflow/scroll, close on source removal |
| Pointer context menu | Viewport pointer point; dismiss on scroll, zoom or resize |
| Latex editor / slash menu / code language picker / table action menus | Live trigger; provider or explicit menu adapter; bounded placement, keyboard/focus preserved; close or pin according to whether input is unsaved |
| Topbar heading, formatting, zoom and theme menus | Unscaled CSS anchor in sticky shell; viewport-bounded menus; keep responsive behavior |
| Block handle | Unscaled shell; live block/first-line reference; hide or recompute on reflow; drag autoscroll uses actual scrollable ancestor |
| Table hover/drag controls | Scene-local adapter with fresh element references and converted dimensions; hide or recompute on reflow |

Updates cover ancestor and nested scroll, viewport resize, canvas resize, fonts/images, non-resizing layout shifts, and zoom. Avoid a permanent per-control polling loop; bounded observation while visible is acceptable. Destroy all observers/listeners on closure or editor replacement. Keep painting native: ProseMirror decorations and CSS Highlights receive no geometry compensation.

### Dependency boundary

Use reproducible, version-bound Bun patches for installed Milkdown implementation defects where public configuration cannot express a fix. Patch both shipped runtime and source, document removal conditions, and verify a clean frozen-lockfile install. Do not rely on untracked node_modules edits or a second editor implementation.

Required changes:

- Link preview: replace frozen rectangle callback with live link range/fragment measurement; use hovered DOM anchor identity where possible rather than unnecessarily round-tripping pointer coordinates through the editor; preserve link edit/remove/copy behavior.
- TooltipProvider, BlockProvider and the separate SlashProvider: consistent observation while visible and stale-result cancellation, correct teardown, fresh source and offscreen handling; retain Floating UI conversion rather than hand-reimplementing it.
- Image load/resize: convert measured widths and pointer distances into local layout units before CSS assignment or ratio persistence.
- Table handles/drag previews: convert dimensions and pointer positions into their real positioning parent's units; remove offsetTop/viewport arithmetic; preserve row/column selection and drag results.
- Block dragging: scroll the actual ancestor/window rather than assuming the editor parent scrolls.
- ProseMirror nested selection scrolling: use a scoped `handleScrollToSelection` adapter with scale-aware ancestor deltas, or a reproducible targeted upstream correction; never add viewport deltas directly to local scrollLeft/scrollTop. Preserve native window and CodeMirror scrolling.

## Execution sequence

1. Review this plan with an Astra adversarial reviewer; revise until explicit ready-to-execute approval. Record findings and disposition here.
2. Before implementation, create `fix/canvas-geometry`; commit the existing security-audit revision separately, then this approved plan; push both commits to origin. User authorized all existing uncommitted changes. No PR or merge requested.
3. Establish a durable browser fixture using actual Tether styles, editor extensions and public controls; record failing link-hover/scroll cases and capture browser versions. **Before migrating consumers, prove the transform topology in Chromium and available WebKit:** native caret/selection, nested code/table scrolling (including the planned scale-aware scroll adapter), sticky toolbar, 75% scroll extent, 175% document-bottom reachability, and free-overlay escape. If browser execution remains blocked, stop at this gate and request unblocking; do not silently adopt the topology. If the gate fails, revise the topology and obtain reviewer approval rather than adding compensating geometry patches.
4. Implement the scale owner and shared Tether overlay controller. Migrate annotation forms, footnotes, selection dialogs and context menu; preserve input and selection state.
5. Apply the bounded upstream fixes for live tooltips, block handle observation/autoscroll, image sizing and table geometry. Remove obsolete cmux CSS-zoom compensation once all Tether canvas geometry uses standard viewport rectangles; preserve range-backed non-mutating find.
6. Run browser regression coverage, meaningful unit/lifecycle tests, the full repository check, and inspect the diff. Fix discovered regressions before completion. Review implementation against the approved contract, including reviewer feedback where needed.
7. Update this plan with actual validation, limitations and files changed; register it in Tether Recents. Report the build ready for Hart's live test, distinguishing unverified host-specific behavior.

## Verification gates

- Supported Chromium and WebKit, including available older WebKit, at 75/100/125/175% plus an intermediate scale; actual versions recorded.
- Real link hover at top/middle/bottom, wrapped links and viewport edges; pointer transfer into preview; edit/remove/copy actions; hover with and without focus. Assert the intended link identity, popup bounds and anchor gap, not forced styles.
- Open controls during window scroll, code horizontal scroll, resize, rail toggle, typography change, font/image load and source mutation/removal; verify cleanup and no stale writes after close.
- Latex editing, slash menu, language picker, topbar heading/formatting/theme/zoom menus and table action menus retain placement, keyboard use and clipping behavior.
- Native text selection, code selection, comment creation, annotation highlights and cmux range-based search navigation remain correct; no Markdown changes from zoom/hover/scroll.
- Image resize tracks the pointer in viewport pixels at each scale, persisted ratio stable; table row/column handles and drag previews match cells, drag targets and content remain correct; the ProseMirror drop insertion marker uses the positioned transformed scene as its offset parent.
- Zoom preserves a visible text anchor; document bottom reachable without phantom space; sticky toolbar, narrow viewport and nested scrollers remain usable; code virtualization does not create a scroll jump.
- Focused unit tests cover conversion with nonzero origins, nested scroll and scaling; lifecycle tests cover detached sources, unsaved forms and destruction. Full `bun run check` required; environment failures reported separately from passing assertions.

## Adversarial review

Round 1 — Astra rejected the draft: missing early browser proof gate; scaled floating controls conflicted with stage clipping; incomplete menu inventory; ProseMirror nested-scroll unit mismatch; proposed removal of scrollbar clearance without evidence.

Revision: retain unscaled Milkdown shell and portal free controls there; gate consumer migration on browser proof; add all enabled menus and nested-scroll adapter; preserve measured scrollbar clearance. Round 2 — Astra approved the revised plan as ready to execute. Added explicit SlashProvider coverage, drop insertion marker verification and the distinction between unscaled block handles and scene-local table controls. The browser proof remains a mandatory execution gate; implementation starts only after pre-build commits are pushed.

## Execution result — 2026-09-16

Implemented on `fix/canvas-geometry`. Pre-build commits `7d48306` (existing security-audit revision) and `f021e45` (this reviewed plan) were pushed before implementation. Hart subsequently live-tested the fixes at all application zoom levels, reported them solid, and approved committing and pushing the implementation.

### Ownership after the change

- `src/web/canvas.ts` and `canvas.css` own document scaling, scene width, measured scroll extent and reading-position preservation. A visible character anchors zoom through asynchronous node-view layout; user input cancels that adjustment. The toolbar and free Milkdown controls live in the unscaled shell.
- `src/web/scroll-geometry.ts` owns ProseMirror selection scrolling. It consumes the required viewport displacement through each actual nested scroller, converting to that scroller's local units once, then scrolls the window below the sticky toolbar.
- `src/web/overlay.ts` owns Tether overlay placement and follow/pin/dismiss policies. Annotation forms, footnotes, selection dialogs and pointer menus use it. Draft forms remain open through geometry changes; stale selection actions cannot modify old document coordinates.
- The patched tooltip package owns the shared active-geometry scheduler, viewport/local conversion and Milkdown collision fitting. Block, slash, link, code-language and table controls consume those primitives. Free controls use the shell; embedded image/table controls use local scene units. Closed/detached controls stop tracking and asynchronous placements cannot revive them.
- Native DOM ranges still own highlights and hit testing. The former cmux CSS-zoom correction, reciprocal toolbar zoom and separate annotation zoom have been removed.

### Dependency maintenance

Milkdown's entry dependencies are pinned to 7.22.1. Bun applies the four version-bound patches in `patches/`; `bun.lock` records their paths. Each patch changes both upstream TypeScript and shipped JavaScript/declarations. The helper is exported through the existing tooltip package; no additional production dependency is introduced. Playwright is a development dependency.

To upgrade Milkdown, inspect the upstream implementations and remove each patch only when upstream supplies its behavior: live semantic link anchors and forced source-loss dismissal; shell-rooted free controls with guarded remeasurement; scene-local image/table dimensions and pointer conversion; bounded table and language menus. Re-run the geometry suite and complete check after replacing patches. Do not retain a patch merely because it still applies. When recording changes with Bun, exclude generated `.bun-tag-*` cache files from patches.

A separate directory installed the final dependency tree with `bun install --frozen-lockfile --ignore-scripts`. PR CI subsequently exposed an EOF-context defect in the tooltip export patch that a reused package cache had hidden. The patch was regenerated against the original package with exports before the source-map footer; a new empty-cache install verified the helper exports through both the tooltip package and Milkdown kit.

### Verified

`bun run check:geometry` ran against Chromium 151.0.7922.34 and WebKit 26.5 at 75%, 100%, 113%, 125% and 175%. The fixture uses actual Crepe, Tether canvas/annotation/selection controllers, production styles and served font assets. All ten runs passed, without browser errors in the final run:

- Native caret placement and drag selection; correct scene offset parent and clipped scroll extent; document bottom reachable and toolbar sticky.
- Actual hyperlink hover identity, live placement through scrolling, pointer transfer into the preview, forced dismissal when its source scrolls away and successful subsequent hover.
- Comment entry preserved during scroll, comment creation and annotation highlight rendering; no Markdown mutation from zoom/hover/selection.
- Rail reflow, nested code horizontal scrolling, bounded language picker with usable trigger, image resize tracking the pointer, actual table action hit testing/alignment, and nested table caret scrolling.
- Stale Tags → detail transitions rejected without modifying Markdown; long wrapped text preserves its visible character within 3 viewport pixels across zoom changes.

Four focused geometry tests cover nonzero origins, scaling, borders, nested scroll consumption, collision placement, draft pinning, source loss, dismissal and scheduler cleanup. The complete repository check passed: **316 tests, zero failures**, TypeScript check and production web build.

Astra reviewed the implementation in addition to the plan. Review identified and led to fixes for stale tag descriptors, hovered-link source loss, whole-paragraph reading anchors, table reflow/cancellation, clipped table actions and synchronous image-resize observer writes. Final narrow review accepted the corrections with no remaining blockers; the complete check subsequently passed.

### Limits of this verification

Browser execution required the explicitly authorized terminal worker because this session cannot launch/connect to browsers through macOS IPC. The worker ran the repository scripts without changing test assertions. The fixture exercises actual editor modules but is not a daemon-backed application walkthrough. Native cmux/Wave webviews, older WebKit, browser-level page zoom, complete theme/overflow/latex/slash interactions and native row/column drag-and-drop were not end-to-end verified; their affected coordinate paths were inspected and patched where applicable. Hart subsequently reported the fixes solid at all zoom levels during live testing; that report does not establish exhaustive coverage of every interaction listed here. The supported application zoom range remains 75–175%; this implementation does not introduce a new range.
