/** Publisher bytes travel through pipes, never arguments, environment, or files. */
export interface PublisherVault {
  create(vault: string, title: string, contents: Uint8Array): Promise<string>;
  read(vault: string, id: string): Promise<Uint8Array>;
}
export function onePassword(executable = "op"): PublisherVault {
  async function call(args: string[], input?: Uint8Array): Promise<Uint8Array> {
    let child: ReturnType<typeof Bun.spawn>;
    try { child = Bun.spawn([executable, ...args], { stdin: input ? new Blob([Buffer.from(input)]) : "ignore", stdout: "pipe", stderr: "ignore", timeout: 120_000 }); }
    catch { throw new Error("1Password CLI could not start. Install op and enable its desktop-app integration."); }
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 32_768) { child.kill(); throw new Error("Unexpected 1Password response size."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (await child.exited !== 0) throw new Error("1Password operation failed. Check the desktop app; creation may have completed, so inspect the named item before retrying.");
    return Buffer.concat(chunks, size);
  }
  return {
    async create(vault, title, contents) {
      const output = await call(["document", "create", "-", "--vault", vault, "--title", title, "--file-name", "tether-publisher.json", "--format", "json"], contents);
      let id: unknown;
      try { id = JSON.parse(Buffer.from(output).toString()).id; } catch { /* Never quote returned contents. */ }
      if (typeof id !== "string" || !/^[a-z0-9]{26}$/.test(id)) throw new Error("1Password creation receipt is missing. Inspect the named vault item before retrying.");
      return id;
    },
    read: (vault, id) => call(["document", "get", id, "--vault", vault]),
  };
}
