/** Disposable HTTPS browser + shared daemon + outbound connector check; no personal profile or passkey. */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { LocalFileAccess } from "../src/documents/file-access";
import { runFileConnector } from "../src/remote/connector";
import { beginSharedPairing, pollSharedPairing, sharedRequest } from "../src/remote/shared-client";
import { prepareConfig, resolveConfig } from "../src/server/config";
import { startDaemon, type TetherDaemon } from "../src/server/server";
import { writeSharedConfig } from "../src/server/shared-profile";

const directory = await mkdtemp("/tmp/tether-shared-browser-");
let daemon: TetherDaemon | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let safari: Awaited<ReturnType<typeof webkit.launch>> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
let connector: Promise<void> | undefined;
const errors: string[] = [];
const consoleErrors: string[] = [];
const failed: string[] = [];
let lastPage: import("playwright").Page | undefined;
const stop = new AbortController();
const eventually = async (check: () => Promise<boolean>, message: string) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(50); }
  throw new Error(message);
};
try {
  const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdout: "ignore", stderr: "ignore" });
  assert.equal(await certificate.exited, 0);
  // Reserve an available loopback port without changing the runtime's fixed-port contract.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const sharedPort = reservation.port!;
  await reservation.stop(true);
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60,
    tls: { key: Bun.file(join(directory, "key.pem")), cert: Bun.file(join(directory, "cert.pem")) },
    fetch: request => {
      const target = new URL(request.url); target.protocol = "http:"; target.hostname = "127.0.0.1"; target.port = String(sharedPort);
      return fetch(new Request(target, request), { redirect: "manual", decompress: false });
    },
  });
  const origin = `https://localhost:${proxy.port}`;
  const trustedFetch = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
    ...init, tls: { ca: Bun.file(join(directory, "cert.pem")) },
  })) as typeof fetch;
  const config = resolveConfig({ profile: "shared-browser-test", configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  await prepareConfig(config);
  await writeSharedConfig(config, { origin, port: sharedPort, owner: "Test owner", active: true });
  daemon = await startDaemon({ config, keepAlive: true, persistentViews: false });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 900 } });
  lastPage = page;
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) failed.push(`${new URL(response.url()).pathname}: ${response.status()}`); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const setup = await daemon.shared!.localControl("enroll", {}) as { code: string };
  await page.goto(`${origin}/auth/enroll`);
  await page.locator("#code").fill(setup.code);
  await page.locator("#register").click();
  await page.getByText("Owner passkey enrolled.", { exact: false }).waitFor();
  const enroll = async (kind: "agent" | "connector") => {
    const pending = await beginSharedPairing(origin, `Test ${kind}`, kind, trustedFetch);
    await page.goto(pending.verificationUrl);
    await page.locator("#code").fill(pending.code);
    await page.locator("#approve").click();
    await page.getByText("Client approved.", { exact: false }).waitFor();
    const credential = await pollSharedPairing(origin, pending, trustedFetch);
    assert(credential); return credential;
  };
  const agent = await enroll("agent"), machine = await enroll("connector");
  const remotePath = join(directory, "remote.md");
  const source = "# Shared browser check\n\nConnector text.\n\n![Referenced image](image.svg)\n\n```mermaid\nflowchart LR\nBrowser --> Service --> Connector\n```\n";
  await writeFile(remotePath, source);
  await writeFile(join(directory, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  let connected = false;
  connector = runFileConnector({ endpoint: origin, token: machine.token, machineId: machine.machineId!, files: new LocalFileAccess(), lockPath: join(directory, "connector.lock"), signal: stop.signal, fetch: trustedFetch, onStatus: value => { connected = value === "connected"; } });
  void connector.catch(() => {});
  await eventually(async () => connected, "Connector did not connect");
  const rpc = <T = Record<string, any>>(operation: string, input: Record<string, unknown>) => sharedRequest<T>(agent, operation, input, { fetch: trustedFetch });
  const registered = await rpc("document.register", { path: remotePath, machineId: machine.machineId });
  const documentId = registered.documentId;
  await page.goto(`${origin}/reader/d/${documentId}/`);
  await page.locator("#login").click();
  await page.locator(".ProseMirror h1").waitFor();
  assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
  await page.locator(".wm-mermaid svg").waitFor();
  assert(await page.locator(".ProseMirror img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0));
  await page.locator("#source").click();
  const editor = page.locator(".wm-source-editor .cm-content");
  await editor.fill(`${source}\nBrowser edit.\n`);
  await eventually(async () => (await readFile(remotePath, "utf8")).includes("Browser edit."), "Browser save did not reach the connector file");
  const current = await rpc("document.read", { documentId });
  assert.equal(current.locationVersion, 1);
  const comment = await rpc("review.comment", { documentId, actor: "assistant", quote: "Connector text.", body: "Shared conversation.", operationId: "browser-test-comment" });
  assert(comment);
  await page.locator("#source").click();
  await page.locator(".wm-source-editor").waitFor({ state: "detached" });
  await page.locator("#comment").click();
  await page.getByText("Shared conversation.", { exact: true }).first().waitFor();
  await page.goto(`${origin}/folio/`);
  await page.locator(".file").first().waitFor();
  assert((await page.locator(".name").allTextContents()).includes("remote"));
  await page.locator(".file").first().click();
  await page.locator(".ProseMirror h1").waitFor();
  // Reuse the authenticated session in real WebKit's touch viewport.
  safari = await webkit.launch();
  const mobile = await safari.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 728 }, isMobile: true, hasTouch: true, storageState: await page.context().storageState() });
  const phone = await mobile.newPage();
  await phone.goto(`${origin}/reader/d/${documentId}/`);
  await phone.locator(".ProseMirror h1").waitFor();
  assert.equal(await phone.locator(".ProseMirror").getAttribute("contenteditable"), "true");
  assert(await phone.locator("#phone-folio").isVisible());
  stop.abort(); await connector;
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.locator("#historical-reviews").waitFor();
  assert.equal(await page.locator("#editor").isVisible(), false);
  await page.locator("#historical-reviews summary").first().click();
  await page.locator("#historical-reviews details p").filter({ hasText: "Shared conversation." }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Shared profile browser check passed: real virtual-passkey enrollment/pairing, TLS, outbound connector, source save, reviews, Folio, diagrams/images, WebKit editing and offline history.");
} catch (error) {
  console.error({ errors, consoleErrors, failed, page: await lastPage?.locator("body").innerText().catch(() => "unavailable") });
  throw error;
} finally {
  stop.abort(); await connector?.catch(() => {});
  await safari?.close(); await browser?.close();
  await daemon?.stop(); await proxy?.stop(true);
  await rm(directory, { recursive: true, force: true });
}
