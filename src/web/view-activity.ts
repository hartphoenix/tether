/** Host state is advisory scheduling information, never an authorization grant. */
export type HostViewState = { visible: boolean; folioRevision?: string };
declare global { interface Window { __tetherHostState?: HostViewState } }

/** Self-contained: Folio embeds this function alongside its inline client. */
export function viewIsVisible(): boolean {
  return !document.hidden && window.__tetherHostState?.visible !== false;
}
