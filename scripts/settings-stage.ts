/** Local-only Settings preview. All API mutations affect disposable simulation state. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { folioHtml, folioTheme } from "../src/web/folio-page";
import { createSimulation, simulate } from "./settings-stage/model";

export async function startSettingsStage(options: { port?: number; proxyOrigin?: string; feedbackFile?: string } = {}) {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "settings-stage/client.ts")], target: "browser", minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } });
  if (!build.success) throw new AggregateError(build.logs, "Settings staging build failed");
  const javascript = await build.outputs[0]!.text();
  const feedbackFile = options.feedbackFile ?? join(import.meta.dir, "../.local/settings-stage/feedback.json");
  const proxy = options.proxyOrigin && new URL(options.proxyOrigin);
  if (proxy && (proxy.protocol !== "http:" || !proxy.hostname.endsWith(".localhost") || proxy.origin !== options.proxyOrigin)) throw new Error("Expected a local Paseo service origin.");
  const sessions = new Map<string, { mode: string; modes: Map<string, ReturnType<typeof fresh>> }>();
  function fresh(mode: string) { return { state: createSimulation(mode === "existing"), preferences: { ...folioTheme({ theme: "tether" }), uiScale: 1, committedUiScale: 1, defaultDocumentZoom: 100, commentTextSize: 16 }, retention: { mode: "days", days: 30 }, sequence: 1 }; }
  let feedbackWrites = Promise.resolve();
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 8416, maxRequestBodySize: 1024 * 1024, async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const allowed = [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, options.proxyOrigin];
    if (!allowed.includes(url.origin) || request.headers.get("host") !== url.host) return new Response("Invalid staging host", { status: 403 });
    if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) return new Response("Invalid staging origin", { status: 403 });
    const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
    if (url.pathname === "/health") return json({ service: "tether-settings-stage" });
    if (url.pathname === "/stage.js") { headers.set("content-type", "text/javascript"); return new Response(javascript, { headers }); }
    if (url.pathname === "/") return Response.redirect(url.origin + "/fresh/settings/", 302);
    try {
      if (url.pathname === "/feedback" && request.method === "POST") {
        const body = await request.json();
        // Accept the former single-page payload from already-open staging tabs.
        const pages = body.pages ?? [body];
        if (!Array.isArray(pages)) throw new Error("Invalid feedback");
        const feedback = pages.map(page => {
          const target = new URL(page.url);
          if (target.origin !== url.origin || !/^\/(fresh|existing)\//.test(target.pathname) || !Array.isArray(page.annotations)) throw new Error("Invalid feedback");
          const key = target.pathname + target.hash;
          return [key, { ...page, output: page.output ?? `## Page Feedback: ${key}\n\n` + page.annotations.map((note: any, index: number) => `### ${index + 1}. ${note.element}\n**Location:** ${note.elementPath}\n**Feedback:** ${note.comment}`).join("\n\n") }] as const;
        });
        feedbackWrites = feedbackWrites.catch(() => {}).then(async () => {
          const saved = JSON.parse(await readFile(feedbackFile, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; }));
          for (const [key, page] of feedback) saved[key] = page;
          await mkdir(join(feedbackFile, ".."), { recursive: true });
          await writeFile(feedbackFile, JSON.stringify(saved, null, 2) + "\n");
        });
        await feedbackWrites; return json({ saved: true });
      }
      let sessionId = request.headers.get("cookie")?.match(/(?:^|; )tether-settings-stage=([a-f0-9-]+)/)?.[1];
      if (!sessionId || !sessions.has(sessionId)) {
        sessionId = crypto.randomUUID(); sessions.set(sessionId, { mode: "fresh", modes: new Map() });
        headers.set("set-cookie", `tether-settings-stage=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
      }
      const browser = sessions.get(sessionId)!;
      if (url.pathname === "/auth/logout" && request.method === "POST") return json({});
      if (url.pathname === "/auth/login" && request.method === "GET") return Response.redirect(url.origin + `/${browser.mode}/setup/sign-in/`, 302);
      const match = url.pathname.match(/^\/(fresh|existing)\/(.*)$/);
      if (!match) return new Response("Not found", { status: 404 });
      const [, mode, path] = match as [string, string, string];
      const session = browser.modes;
      if (!session.has(mode)) session.set(mode, fresh(mode));
      const current = session.get(mode)!;
      const { state } = current;
      const destination = (phase: string) => `/${mode}/${phase === "settings" ? "settings/" : `setup/${phase}/`}`;
      if (path.startsWith("api/")) {
        const action = path.slice(4);
        if (action === "snapshot") return json({ sequence: current.sequence, files: [], retention: current.retention, preferences: current.preferences });
        if (action === "preferences" && request.method === "GET") return json(current.preferences);
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const body = await request.json();
        if (action === "fly/status") return json({ ...state, origin: state.configured ? url.origin + `/${mode}` : undefined });
        if (action === "preferences-preview") return json({});
        if (action === "preferences") { Object.assign(current.preferences, { uiScale: body.uiScale, committedUiScale: body.uiScale, defaultDocumentZoom: body.defaultDocumentZoom, commentTextSize: body.commentTextSize }); current.sequence++; return json(current.preferences); }
        if (action === "settings") { current.retention = body.retention; current.sequence++; return json({}); }
        if (action === "stage/reset") { session.set(mode, fresh(mode)); headers.set("x-stage-navigate", `/${mode}/settings/`); return json({}); }
        if (action.startsWith("fly/") || action.startsWith("stage/")) {
          const next = simulate(state, action.split("/")[1]!, body);
          if (next) headers.set("x-stage-navigate", destination(next));
          return json({});
        }
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!["settings/", "setup/agent/", "setup/sign-in/", "setup/verify/", "setup/complete/", "folio/"].includes(path)) return new Response("Not found", { status: 404 });
      browser.mode = mode;
      const signIn = path === "setup/sign-in/", flow = path.startsWith("setup/");
      const ribbon = `<aside id="stage-controls" aria-label="Staging controls"><strong>Settings staging</strong><span>Simulation only · no installation or real credentials</span><nav><a href="/fresh/settings/" ${mode === "fresh" ? 'aria-current="page"' : ""}>Fresh install</a><a href="/existing/settings/" ${mode === "existing" ? 'aria-current="page"' : ""}>Existing setup</a><button data-stage-action="reset">${mode === "fresh" ? "Reset to fresh install" : "Reset existing setup"}</button></nav>${state.phase === "agent" ? '<button data-stage-action="install">Run simulated installation</button><span>Approve the agent below, then run the simulation.</span>' : ""}${state.phase === "verify" ? '<span>All checks below are simulated; select and confirm them to finish.</span>' : ""}<span id="stage-feedback" role="status">Use Agentation at bottom right; Send includes saved notes from every page. Reset keeps annotations.</span><button id="stage-send-feedback">Send all feedback</button></aside>`;
      let html = folioHtml({ settingsOnly: true, settingsStepUrls: true, apiBase: `/${mode}/api`, shared: true, serviceControls: false, theme: "tether" });
      // Install the navigation bridge before the real Settings script issues requests.
      html = html.replace("<head>", `<head><script>const stageFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await stageFetch(...args);const next=response.headers.get('x-stage-navigate');if(next&&response.ok)setTimeout(()=>location.assign(next),0);return response};</script>`);
      html = html.replace("</head>", `<style>#stage-controls{display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--line);padding:0 0 20px;margin-bottom:28px;font-size:13px}#stage-controls nav{display:flex;flex-wrap:wrap;align-items:center;gap:14px}#stage-controls a{color:var(--accent)}#stage-controls [aria-current]{font-weight:700}#stage-controls button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text)}#stage-controls span{color:var(--muted)}${flow ? "#general-settings,#settings-title{display:none}#fly-settings{margin:0;padding:0;border:0}" : ""}${signIn ? "#fly-settings{display:none}" : ""}</style></head>`);
      html = html.replace("<body>", `<body>${ribbon}`);
      if (flow) html = html.replace('<div id="general-settings">', `<a class="setup-back" href="/${mode}/settings/">← Settings</a><div id="general-settings">`);
      if (signIn) html = html.replace('<div id="general-settings">', '<section class="settings-section"><h3>Sign in to your hub</h3><p>The simulated installation is ready. This stands in for owner passkey enrollment and browser sign-in.</p><button data-stage-action="sign-in">Simulate passkey sign-in</button></section><div id="general-settings">');
      html = html.replace("</body>", '<script type="module" src="/stage.js"></script></body>');
      headers.set("content-type", "text/html"); return new Response(html, { headers });
    } catch (error) { return json({ error: { message: (error as Error).message } }, 400); }
  } });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

if (import.meta.main) {
  const stage = await startSettingsStage({ port: Number(process.env.PASEO_PORT ?? 8416), proxyOrigin: process.env.PASEO_URL });
  console.log(`Settings staging: ${process.env.PASEO_URL ?? stage.url}\nDisposable simulation. Agentation Send saves to .local/settings-stage/feedback.json.`);
  await new Promise<void>(resolve => { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, resolve); });
  await stage.close();
}
