import { iconSvg } from './phosphor-icons';

type Phosphor = Parameters<typeof iconSvg>[0];
// Rows identify controls, not just glyphs: shared glyphs may get different replacements.
function row(id: string, label: string, area: string, source: string, phosphor: Phosphor | null, size: number, suggestions: string[], rotate = false, note = '', targets: string[] = []) {
  return { id, label, area, source, phosphor, size, suggestions, svg: phosphor ? iconSvg(phosphor) : '', rotate, note, targets };
}
const rail = 20 * 9 / 11;
export const rows = [
  row('source', 'Edit Markdown source', 'Reader', 'src/web/index.html', 'code', 16, ['code', 'code-xml', 'file-code']),
  row('document-zoom', 'Document zoom', 'Reader', 'src/web/index.html', 'magnifying-glass-plus', 16, ['zoom-in', 'search', 'scan']),
  row('theme', 'Theme', 'Reader', 'src/web/index.html', 'paint-brush', 16, ['paintbrush', 'palette', 'swatch-book']),
  row('threads', 'Show threads', 'Reader', 'src/web/index.html', 'chat', 16, ['message-square', 'messages-square', 'panel-right']),
  row('formatting', 'More formatting tools', 'Formatting', 'src/web/app.ts', 'text-aa', 16, ['case-sensitive', 'type', 'text-cursor-input']),
  row('code-block', 'Insert code block', 'Formatting', 'src/web/app.ts', 'code-block', 16, ['square-code', 'code-xml', 'file-code']),
  row('decrease-quote', 'Decrease quote level', 'Formatting', 'src/web/app.ts', 'quotes', 16, ['quote', 'text-quote', 'indent-decrease'], true),
  row('thread-zoom', 'Thread zoom', 'Threads', 'src/web/thread-sizing.ts', 'magnifying-glass-plus', rail, ['zoom-in', 'search', 'type']),
  row('file-actions', 'File actions', 'Threads', 'src/web/file-actions.ts', 'file-code', rail, ['file-cog', 'file', 'file-code']),
  row('show-resolved', 'Show resolved', 'Threads', 'src/web/annotations-ui.ts', 'check-square-offset', rail, ['square-check', 'list-checks', 'circle-check']),
  row('edit-footnote', 'Edit footnote', 'Footnotes', 'src/web/annotations-ui.ts', 'pencil-simple-line', 20, ['pencil-line', 'square-pen', 'pencil']),
  row('export-review', 'Export with annotations', 'Threads', 'src/web/annotations-ui.ts', 'download-simple', rail, ['download', 'file-down', 'notebook-pen']),
  row('copy-review-path', 'Copy file path', 'Threads', 'src/web/annotations-ui.ts', 'file-code', rail, ['copy', 'file-code', 'clipboard-copy']),
  row('copy-path', 'Copy file path', 'File menu', 'src/web/file-actions.ts', 'file-code', 20, ['copy', 'clipboard-copy', 'file-code']),
  row('reveal', 'Reveal in Finder', 'File menu', 'src/web/file-actions.ts', 'folder-open', 20, ['folder-open', 'folder-search', 'folder']),
  row('move', 'Move file', 'File menu', 'src/web/file-actions.ts', 'folder-simple-dashed', 20, ['folder-input', 'folder-output', 'folder-symlink']),
  row('export-file', 'Export with annotations', 'File menu', 'src/web/file-actions.ts', 'file-arrow-down', 20, ['file-down', 'download', 'file-output']),
  row('active', 'Active documents', 'Folio', 'src/web/folio-page.ts', 'pulse', 16, ['activity', 'files', 'inbox']),
  row('archive', 'Archive', 'Folio', 'src/web/folio-page.ts', 'archive', 16, ['archive', 'archive-restore', 'folder-archive'], false,
    'Shared by the Archive section and batch Archive (currently text-only). Replace batch text with this icon; retain its accessible label. Restore is a separate state.',
    ['.tab[data-view="archive"]', '#batch-move (active view / Archive action only)']),
  row('filters', 'Show filters', 'Folio', 'src/web/folio-page.ts', 'funnel', 16, ['funnel', 'list-filter', 'filter']),
  row('view-options', 'View options', 'Folio', 'src/web/folio-page.ts', 'sliders-horizontal', 16, ['sliders-horizontal', 'settings-2', 'list-filter']),
  row('open-threads', 'Open threads', 'Folio', 'src/web/folio-page.ts', 'chat', 16, ['message-square', 'messages-square', 'message-circle']),
  row('folio-menu', 'Folio menu', 'Folio', 'src/web/folio-page.ts', 'list', 16, ['menu', 'ellipsis', 'list']),
  row('folio-select', 'Select documents', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['list-checks', 'square-check', 'mouse-pointer-2'], false, 'Add an icon to the left of the label.', ['#app-menu #select']),
  row('folio-open', 'Open Markdown', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['folder-open', 'file-plus', 'file-text'], false, 'Add an icon to the left of the label.', ['#app-menu #add']),
  row('folio-import', 'Import annotations', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['file-input', 'import', 'message-square-plus'], false, 'Add an icon to the left of the label.', ['#app-menu [data-app-action="import"]']),
  row('folio-check-updates', 'Check for updates', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['refresh-cw', 'package-check', 'download'], false, 'Add an icon to the left of the label.', ['#app-menu #check-updates']),
  row('folio-settings', 'Settings', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['settings', 'sliders-horizontal', 'settings-2'], false, 'Add an icon to the left of the label.', ['#app-menu [data-app-action="settings"]']),
  row('folio-restart', 'Restart service', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['rotate-cw', 'refresh-cw', 'power'], false, 'Add an icon to the left of the label.', ['#app-menu [data-app-action="restart"]']),
  row('folio-quit', 'Quit Tether', 'Folio menu', 'src/web/folio-page.ts', null, 16, ['power', 'log-out', 'circle-x'], false, 'Add an icon to the left of the label.', ['#app-menu [data-app-action="quit"]']),
  row('clear-filter', 'Clear filter', 'Folio', 'src/web/folio-page.ts', 'x', 20, ['x', 'circle-x', 'list-x']),
  row('delete-filter', 'Delete saved filter', 'Folio', 'src/web/folio-page.ts', 'x', 13, ['x', 'trash-2', 'circle-minus']),
  row('pin', 'Pin selected documents', 'Folio', 'src/web/folio-page.ts', 'map-pin-simple', 20, ['pin', 'map-pin', 'bookmark']),
  row('batch-export', 'Export selected documents', 'Folio', 'src/web/folio-page.ts', 'download-simple', 20, ['download', 'files', 'folder-output']),
  row('finish-selection', 'Finish selecting', 'Folio', 'src/web/folio-page.ts', 'x', 20, ['x', 'check', 'circle-check']),
  row('folio-update', 'Update available', 'Folio', 'src/web/folio-page.ts', 'package', 16, ['package', 'package-check', 'download']),
  row('reader-update', 'Update available', 'Reader', 'src/web/app.ts', 'package', 20, ['package', 'package-check', 'download']),
  row('edit-theme', 'Edit theme', 'Appearance', 'src/web/themes.ts', 'pencil-simple-line', 14, ['pencil-line', 'palette', 'square-pen']),
  row('diagram-zoom-out', 'Zoom out', 'Diagram', 'src/web/diagram-viewer.ts', 'magnifying-glass-minus', 20, ['zoom-out', 'minus', 'circle-minus']),
  row('diagram-zoom-in', 'Zoom in', 'Diagram', 'src/web/diagram-viewer.ts', 'magnifying-glass-plus', 20, ['zoom-in', 'plus', 'circle-plus']),
  row('diagram-fit', 'Fit diagram', 'Diagram', 'src/web/diagram-viewer.ts', 'corners-in', 20, ['minimize', 'shrink', 'scan']),
  row('diagram-close', 'Close diagram', 'Diagram', 'src/web/diagram-viewer.ts', 'x', 20, ['x', 'circle-x', 'minimize-2']),
];
