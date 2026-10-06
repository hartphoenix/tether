import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyRevision } from "../src/core/index";
import { FileAccessError, LocalFileAccess, type FileLocation } from "../src/documents/file-access";
import { ConnectorBroker, runFileConnector } from "../src/remote/connector";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Condition did not become true"); await Bun.sleep(5); }
}
const makeBroker = () => new ConnectorBroker({ authorizeMachine: (client, machine) => client === "client" && machine === "machine", pollTimeoutMs: 10, requestTimeoutMs: 2_000 });
async function fixture(options: { files?: LocalFileAccess; intercept?: (request: Request, next: () => Promise<Response>) => Promise<Response> } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tether-connector-")));
  const path = join(directory, "document.md"); await writeFile(path, "original");
  const location: FileLocation = { documentId: "document", machineId: "machine", path, version: 1 };
  let broker = makeBroker(); const abort = new AbortController();
  const requests: Request[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request.clone());
    const next = () => broker.handle(request, "client");
    return options.intercept ? options.intercept(request, next) : next();
  }) as typeof fetch;
  const files = options.files ?? new LocalFileAccess();
  const running = runFileConnector({ endpoint: "https://tether.test", token: "test-only-token", machineId: "machine", lockPath: join(directory, "connector.lock"), files, signal: abort.signal, fetch: transport, retryMinMs: 5 });
  // Preserve a rejected background promise for the assertion without an unhandled rejection.
  running.catch(() => {});
  cleanup.push(async () => { abort.abort(); await running.catch(() => {}); broker.close(); await rm(directory, { recursive: true, force: true }); });
  await eventually(() => broker.connected("machine"));
  return { directory, location, files, abort, running, requests, transport, get broker() { return broker; }, replaceBroker() { broker.close(); broker = makeBroker(); return broker; } };
}
async function rpc(broker: ConnectorBroker, route: string, body: unknown, client = "client") {
  return broker.handle(new Request(`https://tether.test/connector/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), client);
}

describe("outbound file connector", () => {
  test("uses the outbound HTTP channel without exposing the token in document data", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tether-connector-http-")));
    const path = join(directory, "document.md"); await writeFile(path, "over HTTP");
    const broker = makeBroker(), abort = new AbortController();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => request.headers.get("authorization") === "Bearer test-only-token"
      ? broker.handle(request, "client") : new Response(null, { status: 401 }) });
    const running = runFileConnector({ endpoint: `http://127.0.0.1:${server.port}`, allowLoopbackHttp: true, token: "test-only-token", machineId: "machine", lockPath: join(directory, "connector.lock"), files: new LocalFileAccess(), signal: abort.signal });
    running.catch(() => {});
    cleanup.push(async () => { abort.abort(); await running.catch(() => {}); broker.close(); await server.stop(true); await rm(directory, { recursive: true, force: true }); });
    await eventually(() => broker.connected("machine"));
    const file = await broker.adapter("machine").read({ documentId: "document", machineId: "machine", path, version: 1 });
    expect(file).toEqual({ source: "over HTTP", bodyRevision: bodyRevision("over HTTP") });
  });

  test("uses the file adapter for reads, conditional writes, images, and links", async () => {
    const context = await fixture();
    const files = context.broker.adapter("machine"), location = context.location;
    expect((await files.inspect(location.path)).path).toBe(location.path);
    expect(await files.read(location)).toEqual({ source: "original", bodyRevision: bodyRevision("original") });
    const markdown = "![image](picture.png)\n[[other.md]]";
    await writeFile(join(context.directory, "picture.png"), Buffer.from("89504e470d0a1a0a00000000", "hex"));
    await writeFile(join(context.directory, "other.md"), "other");
    const saved = await files.save(location, { body: markdown, expectedBodyRevision: bodyRevision("original") });
    expect(saved.source).toBe(markdown);
    expect(await readFile(location.path, "utf8")).toBe(markdown);
    expect((await files.image(location, "picture.png")).contentType).toBe("image/png");
    expect((await files.resolveLink(location, "other", "wikilink")).path).toBe(join(context.directory, "other.md"));
    await expect(files.image(location, "other.md")).rejects.toBeInstanceOf(FileAccessError);
    await expect(files.save(location, { body: "stale", expectedBodyRevision: bodyRevision("original") })).rejects.toMatchObject({ code: "stale_revision", status: 409 });
  });

  test("rejects another client's machine and incompatible protocol", async () => {
    const broker = makeBroker(); cleanup.push(async () => broker.close());
    expect((await rpc(broker, "connect", { machineId: "machine", protocol: 1, instanceId: "process", drained: true }, "other")).status).toBe(403);
    expect((await rpc(broker, "connect", { machineId: "other", protocol: 1, instanceId: "process", drained: true })).status).toBe(403);
    expect((await rpc(broker, "connect", { machineId: "machine", protocol: 9, instanceId: "process", drained: true })).status).toBe(426);
    expect((await rpc(broker, "connect", { machineId: "machine", protocol: 1, instanceId: "process", drained: false })).status).toBe(409);
    expect(broker.connected("machine")).toBe(false);
  });

  test("a lost save response remains unknown and reconnect verifies without replay", async () => {
    let dropped = false, saves = 0;
    const local = new LocalFileAccess(), save = local.save.bind(local);
    local.save = async (location, input) => { saves++; return save(location, input); };
    const context = await fixture({ files: local, intercept: async (request, next) => {
      if (new URL(request.url).pathname.endsWith("/result")) {
        const body = await request.clone().json() as any;
        if (body.value?.source === "attempt" && !dropped) { dropped = true; throw new Error("response connection lost"); }
      }
      return next();
    } });
    const files = context.broker.adapter("machine");
    await expect(files.save(context.location, { body: "attempt", expectedBodyRevision: bodyRevision("original") })).rejects.toMatchObject({ code: "outcome_unknown" });
    await eventually(() => context.broker.connected("machine"));
    await files.barrier(context.location);
    expect((await files.read(context.location)).source).toBe("attempt");
    expect(saves).toBe(1);
    const commands = await Promise.all(context.requests.filter(request => new URL(request.url).pathname.endsWith("/result")).map(request => request.json()));
    expect(commands.filter((value: any) => value.error?.code === "stale_revision")).toHaveLength(0);
  });

  test("service restart waits for the old operation before a fresh handshake", async () => {
    const started = deferred(), finish = deferred();
    const local = new LocalFileAccess({ beforeBodyReplace: async () => { started.resolve(); await finish.promise; } });
    const context = await fixture({ files: local });
    const save = context.broker.adapter("machine").save(context.location, { body: "after restart", expectedBodyRevision: bodyRevision("original") });
    const outcome = save.catch(error => error);
    await started.promise;
    const replacement = context.replaceBroker();
    expect((await outcome).code).toBe("outcome_unknown");
    await Bun.sleep(20);
    expect(replacement.connected("machine")).toBe(false);
    finish.resolve();
    await eventually(() => replacement.connected("machine"));
    await replacement.adapter("machine").barrier(context.location);
    expect((await replacement.adapter("machine").read(context.location)).source).toBe("after restart");
  });

  test("fence drains a save and rejects all old-location admission", async () => {
    const started = deferred(), finish = deferred();
    const local = new LocalFileAccess({ beforeBodyReplace: async () => { started.resolve(); await finish.promise; } });
    const context = await fixture({ files: local });
    const files = context.broker.adapter("machine");
    const save = files.save(context.location, { body: "saved", expectedBodyRevision: bodyRevision("original") });
    await started.promise;
    let fenced = false;
    const fence = files.fence(context.location).then(() => { fenced = true; });
    await expect(files.read(context.location)).rejects.toMatchObject({ code: "stale_location" });
    expect(fenced).toBe(false);
    finish.resolve(); await save; await fence;
    await files.fence(context.location); // A lost fence response can be retried.
    await expect(files.save(context.location, { body: "old", expectedBodyRevision: bodyRevision("saved") })).rejects.toMatchObject({ code: "stale_location" });
    expect((await files.read({ ...context.location, version: 2 })).source).toBe("saved");
  });

  test("shutdown holds the process lock until accepted disk work finishes", async () => {
    const started = deferred(), finish = deferred();
    const local = new LocalFileAccess({ beforeBodyReplace: async () => { started.resolve(); await finish.promise; } });
    const context = await fixture({ files: local });
    const save = context.broker.adapter("machine").save(context.location, { body: "finishing", expectedBodyRevision: bodyRevision("original") });
    const outcome = save.catch(error => error);
    await started.promise; context.abort.abort();
    await expect(runFileConnector({ endpoint: "https://tether.test", token: "test-only-token", machineId: "machine", lockPath: join(context.directory, "connector.lock"), files: local, signal: new AbortController().signal, fetch: context.transport })).rejects.toMatchObject({ code: "writer_busy" });
    finish.resolve(); await context.running; await outcome;
    expect(await readFile(context.location.path, "utf8")).toBe("finishing");
  });

  test("bounds pending work and rejects stale epoch responses", async () => {
    const broker = makeBroker(); cleanup.push(async () => broker.close());
    const first = await (await rpc(broker, "connect", { machineId: "machine", protocol: 1, instanceId: "process", drained: true })).json() as any;
    const pending = Array.from({ length: 64 }, () => broker.adapter("machine").inspect("/document.md").catch(error => error));
    await expect(broker.adapter("machine").inspect("/overflow.md")).rejects.toMatchObject({ code: "connector_busy" });
    await rpc(broker, "connect", { machineId: "machine", protocol: 1, instanceId: "process", drained: true });
    expect((await rpc(broker, "result", { machineId: "machine", epoch: first.epoch, id: "old", value: {} })).status).toBe(503);
    expect((await Promise.all(pending)).every(error => error.code === "connector_disconnected")).toBe(true);
  });
});
