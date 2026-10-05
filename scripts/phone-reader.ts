import { DesktopReaderBackend } from "../src/remote/desktop-reader";
/** Experimental phone adapter; foreground or supervised. Does not configure Tailscale or enroll by itself. */
import { operationsHealth } from "../src/remote/operations-health";
import { resolve, join, basename } from "node:path";
import { realpath, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolveConfig } from "../src/server/config";
import { startDaemon } from "../src/server/server";
import { LocalReaderBackend } from "../src/remote/local-reader";
import { FilePasskeys } from "../src/remote/passkeys";
import { PhoneGateway } from "../src/remote/gateway";
import { tailscaleIdentity } from "../src/remote/contracts";
import { createDiagramRenderer, type DiagramRenderer } from "../src/remote/diagram-renderer";

const usage = "bun scripts/phone-reader.ts --document FILE --owner LOGIN --reader-origin https://READER_HOST --approval-origin https://APPROVAL_HOST --state-dir DIR [--folio-profile PROFILE] [--enroll]";
export async function main(args: string[]) {
  if (args.includes("--help")) { console.log(usage); return; }
  const values = new Map<string, string>(); let enroll = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--enroll") { enroll = true; continue; }
    if (!["--document", "--owner", "--reader-origin", "--approval-origin", "--state-dir", "--folio-profile"].includes(flag) || !args[index + 1] || values.has(flag)) throw new Error(usage);
    values.set(flag, args[++index]!);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(usage); return value; };
  if (enroll && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Enrollment must be initiated by the owner in an interactive Mac terminal.");
  const revision = await Bun.file(resolve(import.meta.dir, "../.phone-reader-revision")).text().then(value => value.trim(), () => "development");
  const document = await realpath(required("--document"));
  const owner = required("--owner"), readerOrigin = required("--reader-origin"), approvalOrigin = required("--approval-origin");
  const state = resolve(required("--state-dir"));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const passkeys = new FilePasskeys({ file: join(state, "passkey.json"), origin: approvalOrigin, owner });
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/remote/auth-browser.ts")], target: "browser", minify: true });
  if (!build.success || !build.outputs[0]) throw new Error("Could not build passkey page.");
  const config = resolveConfig({ profile: "phone-prototype", runtimeDir: join(state, "runtime"), configDir: join(state, "config") });
  const daemon = await startDaemon({ config, keepAlive: true });
  let gateway: PhoneGateway | undefined;
  let diagrams: DiagramRenderer | undefined;
  const listeners: Array<ReturnType<typeof Bun.serve>> = [];
  try {
    diagrams = await createDiagramRenderer();
    const grant = await daemon.service.open(document);
    const documentId = daemon.service.store.documentForPath(grant.realPath)!.id;
    daemon.service.close(grant);
    const local = new LocalReaderBackend(daemon, new Map([[documentId, document]]));
    const folioProfile = values.get("--folio-profile");
    const backend = folioProfile ? new DesktopReaderBackend(resolveConfig({ profile: folioProfile }), local, documentId) : local;
    gateway = new PhoneGateway({ readerOrigin, approvalOrigin, owner,
      document: { id: documentId, title: basename(document) }, identify: tailscaleIdentity(owner), passkeys, diagrams,
      backend, authJavaScript: await build.outputs[0].text() });
    // Fixed loopback targets make Serve configuration inspectable. Neither is a LAN listener.
    for (const [surface, port] of [["reader", 8413], ["approval", 8414]] as const) {
      listeners.push(Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 120, maxRequestBodySize: 131072,
        fetch: request => operationsHealth(request, surface, revision) ?? gateway!.handle(request, surface) }));
    }
    console.log(`Reader: ${readerOrigin}\nPasskey setup: ${approvalOrigin}/enroll\nNo Tailscale settings were changed. Press Ctrl-C to stop.`);
    if (enroll) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await terminal.question("Owner setup: type ENROLL to open one five-minute enrollment window: "); terminal.close();
      if (answer === "ENROLL") console.log(`One-time setup code (enter only in the setup page): ${gateway.beginEnrollment()}`);
    }
    await new Promise<void>(resolveStop => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
  } finally {
    gateway?.close(); for (const server of listeners) await server.stop(true); await diagrams?.close(); await daemon.stop();
  }
}
if (import.meta.main) main(process.argv.slice(2)).catch(() => { console.error("Phone reader could not start. Check arguments, private state ownership, and loopback ports. Run with --help for usage."); process.exitCode = 1; });
