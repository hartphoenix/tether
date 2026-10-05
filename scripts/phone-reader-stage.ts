import { DesktopReaderBackend } from "../src/remote/desktop-reader";
/** Local development only. Separate entrypoint: never enabled by the production runner. */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveConfig } from "../src/server/config";
import { startDaemon } from "../src/server/server";
import { LocalReaderBackend } from "../src/remote/local-reader";
import { PhoneGateway } from "../src/remote/gateway";
import { createDiagramRenderer } from "../src/remote/diagram-renderer";
import type { RemoteFolioEntry } from "../src/remote/contracts";
import type { PasskeyProvider } from "../src/remote/passkeys";

const READER = "https://reader.staging.invalid", APPROVAL = "https://approval.staging.invalid";
const assets = join(import.meta.dir, "phone-stage");
const names = [["__Host-tether-phone-binding", "tether-stage-binding"], ["__Host-tether-phone", "tether-stage-session"]] as const;
export async function startPhoneStage(options: { port?: number; document?: string; proxyOrigin?: string; folioProfile?: string } = {}) {
  const port = options.port ?? 8415;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || [8413, 8414].includes(port)) throw new Error("Choose a staging port other than the live pilot ports.");
  const proxyOrigin = options.proxyOrigin ? new URL(options.proxyOrigin) : undefined;
  if (proxyOrigin && (proxyOrigin.protocol !== "http:" || !proxyOrigin.hostname.endsWith(".localhost") || proxyOrigin.origin !== options.proxyOrigin)) throw new Error("Expected a local Paseo service origin.");
  const directory = await mkdtemp(join(tmpdir(), "tether-phone-stage-"));
  const document = join(directory, "preview.md");
  const config = resolveConfig({ profile: "phone-stage", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let diagrams: Awaited<ReturnType<typeof createDiagramRenderer>> | undefined;
  let gateway: PhoneGateway | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = async () => { gateway?.close(); await server?.stop(true); await diagrams?.close(); await daemon?.stop(); await rm(directory, { recursive: true, force: true }); };
  try {
    await writeFile(document, await readFile(options.document ? resolve(options.document) : join(assets, "sample.md")));
    daemon = await startDaemon({ config, keepAlive: true, persistentViews: false });
    diagrams = await createDiagramRenderer();
    const grant = await daemon.service.open(document);
    const id = daemon.service.store.documentForPath(grant.realPath)!.id;
    daemon.service.close(grant);
    const locations = new Map([[id, document]]);
    const files: RemoteFolioEntry[] = [{ id, title: "Phone staging", view: "active", pinned: true }];
    for (const [name, title, view] of [["second", "Folio navigation sample", "active"], ["archive", "Archived sample", "archive"]] as const) {
      const path = join(directory, `${name}.md`);
      await writeFile(path, `# ${title}\n\nThis is a disposable Folio document. Select this passage to try a comment.\n`);
      const session = await daemon.service.open(path);
      const documentId = daemon.service.store.documentForPath(session.realPath)!.id;
      daemon.service.close(session);
      locations.set(documentId, path); files.push({ id: documentId, title, view });
    }
    const local = new LocalReaderBackend(daemon, locations);
    const backend = options.folioProfile
      ? new DesktopReaderBackend(resolveConfig({ profile: options.folioProfile }), local, id)
      : { open: (id: string) => local.open(id), list: async () => files };
    const initialDocument = options.folioProfile ? (await backend.list()).find(file => !file.unavailable) : { id, title: "Phone staging" };
    if (!initialDocument) throw new Error("The desktop Folio has no available documents.");
    // Deliberately fake proof, in this staging entrypoint only; no credential files.
    const passkeys: PasskeyProvider = {
      enrolled: () => true,
      registrationOptions: async () => { throw new Error("Staging does not enroll passkeys."); },
      register: async () => { throw new Error("Staging does not enroll passkeys."); },
      authenticationOptions: async () => ({ challenge: randomUUID() } as any),
      authenticate: async (challenge, response) => { if ((response as any)?.proof !== challenge) throw new Error("Invalid staging proof."); },
    };
    gateway = new PhoneGateway({ readerOrigin: READER, approvalOrigin: APPROVAL, owner: "staging", document: initialDocument,
      identify: () => "staging", passkeys, diagrams, backend,
      authJavaScript: await readFile(join(assets, "auth.js"), "utf8") });
    server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 120, maxRequestBodySize: 131072, async fetch(request) {
      const url = new URL(request.url);
      const allowed = new Set([`http://127.0.0.1:${server!.port}`, `http://localhost:${server!.port}`, ...(proxyOrigin ? [proxyOrigin.origin] : [])]);
      if (!allowed.has(url.origin) || request.headers.get("host") !== url.host) return new Response("Invalid staging host", { status: 403 });
      if (!["GET", "POST", "PUT"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
      if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return new Response("Invalid staging origin", { status: 403 });
      const headers = { "cache-control": "no-store" };
      if (url.pathname === "/" && request.method === "GET") {
        let html = await readFile(join(assets, "index.html"), "utf8");
        if (options.folioProfile) html = html
          .replace("A local sandbox for Tether mobile.", "Desktop library · comments are saved to your real conversations.")
          .replace("Comments stay until staging restarts.", "Comments persist in your desktop profile.")
          .replace("with a disposable document and simulated passkey", "with your desktop documents and simulated passkey");
        return new Response(html, { headers: { ...headers, "content-type": "text/html" } });
      }
      if (url.pathname === "/stage.js" && request.method === "GET") return new Response(Bun.file(join(assets, "stage.js")), { headers: { ...headers, "content-type": "text/javascript" } });
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ service: "tether-phone-stage" }, { headers });
      if (url.pathname === "/expire" && request.method === "POST") { gateway!.revokeAll(); return Response.json({ expired: true }, { headers }); }
      const surface = url.pathname.startsWith("/phone/") ? "reader" : url.pathname.startsWith("/approval/") ? "approval" : undefined;
      if (!surface) return new Response("Not found", { status: 404 });
      const prefix = surface === "reader" ? "/phone" : "/approval";
      const path = url.pathname.slice(prefix.length);
      if (path === "/enroll" || path.startsWith("/registration/")) return new Response("Enrollment is disabled in staging", { status: 403 });
      const origin = surface === "reader" ? READER : APPROVAL;
      const incoming = new Headers(request.headers);
      incoming.set("host", new URL(origin).host);
      if (request.method !== "GET") incoming.set("origin", surface === "reader" && path === "/handoff" ? APPROVAL : origin);
      let cookies = incoming.get("cookie") ?? "";
      for (const [real, stage] of names) cookies = cookies.replaceAll(stage + "=", real + "=");
      incoming.set("cookie", cookies);
      const upstream = await gateway!.handle(new Request(origin + path + url.search, { method: request.method, headers: incoming,
        body: request.method !== "GET" ? await request.arrayBuffer() : undefined }), surface);
      const outgoing = new Headers(upstream.headers);
      // Only the local staging bridge permits framing and HTTP cookies. Production remains unchanged.
      const mapUrl = (value: string) => value.replaceAll(READER, url.origin + "/phone").replaceAll(APPROVAL, url.origin + "/approval");
      outgoing.delete("x-frame-options");
      outgoing.set("content-security-policy", mapUrl(outgoing.get("content-security-policy") ?? "").replaceAll("frame-ancestors 'none'", "frame-ancestors 'self'"));
      outgoing.set("cache-control", "no-store");
      if (outgoing.has("location")) {
        const location = outgoing.get("location")!;
        outgoing.set("location", location.startsWith("/") ? prefix + location : mapUrl(location));
      }
      if (outgoing.has("set-cookie")) {
        let value = outgoing.get("set-cookie")!.replace(/; Secure/g, "");
        for (const [real, stage] of names) value = value.replace(real + "=", stage + "=");
        outgoing.set("set-cookie", value);
      }
      const type = outgoing.get("content-type") ?? "";
      let body: BodyInit | null = upstream.body;
      if (type.includes("text/html")) {
        body = mapUrl(await upstream.text()).replace(/(action|src|href)="\/(?!\/)/g, `$1="${prefix}/`);
      } else if (surface === "approval" && path === "/authentication/verify" && upstream.ok) {
        const value = await upstream.json();
        if (value.action) value.action = mapUrl(value.action);
        body = JSON.stringify(value);
      }
      outgoing.delete("content-length");
      return new Response(body, { status: upstream.status, headers: outgoing });
    } });
    return { url: `http://127.0.0.1:${server.port}`, close };
  } catch (error) { await close(); throw error; }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log("bun run stage:phone [--document FILE | --folio-profile PROFILE]\nUses disposable documents unless a desktop Folio profile is explicitly selected. Uses PASEO_PORT or 8415.");
  else {
    if (args.length && (args.length !== 2 || !["--document", "--folio-profile"].includes(args[0]!))) throw new Error("Expected --document FILE or --folio-profile PROFILE");
    const stopped = new Promise<void>(done => {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, done);
    });
    const stage = await startPhoneStage({ port: Number(process.env.PASEO_PORT ?? 8415), proxyOrigin: process.env.PASEO_URL, document: args[0] === "--document" ? args[1] : undefined, folioProfile: args[0] === "--folio-profile" ? args[1] : undefined });
    console.log(`Phone staging: ${process.env.PASEO_URL ?? stage.url}\n${args[0] === "--folio-profile" ? "Desktop profile; comments persist." : "Disposable state."} Simulated sign-in. Stop with Ctrl-C or Paseo's stop button.`);
    await stopped;
    await stage.close();
  }
}
