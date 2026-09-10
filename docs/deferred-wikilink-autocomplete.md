---
title: Deferred wikilink autocomplete
status: deferred pending filesystem scope
created: 2026-09-06
---
# Deferred wikilink autocomplete

## Current position

Tether's wikilink support may remain an unadvertised stub. Existing wikilinks can open a target relative to the source document without replacing the source view, and a successful open records the target in Recents. Tether does not yet need a first-class wikilink authoring workflow.

Do not add filesystem-backed wikilink autocomplete until Tether has a clear browsing and authorization boundary. Tether is a granular reader rather than a vault or document ecosystem, so adopting Obsidian's vault boundary merely to enable autocomplete would distort the product model.

## Desired future behavior

* Typing `[[` in the editor opens a popover file picker listing linkable sibling files in the current document's directory.
* Additional filepath characters filter the displayed filenames and navigate directories. For example, `[[../` makes the picker list linkable files in the parent directory.
* Choosing **Link** from the selection tooltip and typing `/` in its text field opens the same picker.
* The picker responds to typed filename characters by filtering its results. It does not automatically insert or prefill its first suggestion.
* Selecting a suggestion creates Tether's existing wikilink representation, which the Markdown codec saves as `[[target]]` or `[[target|label]]`.

## Research findings

[Milkdown's slash plugin](https://milkdown.dev/docs/api/plugin-slash) is the best existing primitive for the editor interaction. Tether already receives it through `@milkdown/kit`. Its `SlashProvider` handles editor-position tracking, show/hide lifecycle, and floating placement. A custom `shouldShow` predicate would be needed for the multi-character `[[` context. The plugin does not supply a suggestion list, filesystem query, keyboard selection, or insertion behavior.

Two broader ProseMirror libraries were considered:

* [`prosemirror-autocomplete`](https://www.npmjs.com/package/prosemirror-autocomplete) provides open, filter, arrow-key, Enter, and close callbacks, but is UI-less and has not been published recently.
* [`prosemirror-suggest`](https://www.npmjs.com/package/prosemirror-suggest) provides flexible suggestion primitives, but adds more abstraction than this feature needs and belongs to the maintenance-mode [Remirror](https://github.com/remirror/remirror) ecosystem.

Neither library handles filesystem discovery or the ordinary HTML input in Tether's selection tooltip. The smallest coherent implementation would therefore use Milkdown's existing provider plus one small Tether-owned picker shared by the editor and link input. A custom ProseMirror plugin built from the official [plugin and view APIs](https://prosemirror.net/docs/ref/) would also be viable if `SlashProvider` proves awkward; a new autocomplete dependency is not presently justified.

Obsidian's documented model resolves links within a vault. Its documentation describes [vault-relative link paths](https://obsidian.md/help/links), and `../` behavior has not been consistently supported by its autocomplete. The desired Tether behavior is more precisely filesystem-relative navigation presented through an Obsidian-like picker.

## Likely implementation shape

When the scope problem is resolved, the feature can remain small:

1. Add a daemon endpoint that accepts the typed relative path under an explicit link-browsing grant, separates its directory and filename portions, and returns directories plus `.md` and `.markdown` files.
2. Resolve and canonicalize every candidate server-side, rejecting traversal beyond the granted boundary.
3. Add a shared browser picker for rendering, filtering, arrow-key navigation, selection, dismissal, and anchoring.
4. Connect the picker to a Milkdown `SlashProvider` with custom `[[` detection.
5. Connect the same picker to the selection tooltip's link input when its value enters a supported path-like form.
6. Insert the selected target through the existing internal wikilink URL and Markdown codec rather than introducing another persisted syntax.

## Unresolved scope decision

The daemon currently grants a browser session access to one canonical document. Recents is only a convenience index and grants no filesystem authority. Listing sibling files broadens that document grant into directory enumeration; supporting `../` broadens it again to ancestor directories.

Before implementation, define what authorizes the browsable root and how that root is conveyed to the document session. Plausible models include an explicit root supplied at launch, a temporary directory grant chosen by the user, or another bounded scope that does not turn Tether into a vault manager. Unrestricted ancestor traversal should not be inferred from opening one document.

