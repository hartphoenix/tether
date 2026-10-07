export type FileMachine = { id: string; name: string; qualifyPaths: boolean };

/** Clipboard paths belong to the file machine, never the viewing device. */
export function formatMachinePath(path: string, machine?: Pick<FileMachine, "name" | "qualifyPaths"> | null): string {
  return machine?.qualifyPaths ? `${machine.name}:${path}` : path;
}
