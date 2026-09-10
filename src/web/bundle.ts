import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { runtimeRoot } from "../runtime-paths";

export type WebResponder = (request: Request) => Response;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

/** Build the browser application in memory once for a source-checkout daemon. */
export async function createWebBundleResponder(): Promise<WebResponder> {
  const installed = process.env.TETHER_INSTALL_ROOT;
  const result = installed ? {
    success: true, logs: [],
    outputs: (await readdir(join(runtimeRoot(), "dist"))).map(name => Bun.file(join(runtimeRoot(), "dist", name))),
  } : await Bun.build({
    entrypoints: [fileURLToPath(new URL("./index.html", import.meta.url))],
    minify: true,
    naming: "[name]-[hash].[ext]",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(`Unable to build the Tether web application: ${result.logs.map(String).join("\n")}`);
  }

  const assetPath = (output: Bun.BunFile | Bun.BuildArtifact) => "path" in output ? output.path : output.name!;
  const assets = new Map(result.outputs.map((output) => [basename(assetPath(output)), output]));
  const index = result.outputs.find((output) => extname(assetPath(output)) === ".html");
  if (!index) throw new Error("The Tether web build did not produce an HTML entry point.");
  assets.set("index.html", index);
  // Bun hashes the icon into the document's cookie-protected asset directory.
  // Native host favicon fetches have no webview cookie, so point them at the
  // same public application icon used by Recents. Rewrite once after building.
  const indexHtml = await new HTMLRewriter()
    .on('link[rel="icon"]', { element: element => { element.setAttribute("href", "/favicon.png"); } })
    .transform(new Response(index)).text();
  return (request) => {
    const pathname = new URL(request.url).pathname;
    const name = pathname.endsWith("/") ? "index.html" : pathname.split("/").at(-1)!;
    const asset = assets.get(name);
    if (!asset) return Response.json({ error: { code: "not_found", message: "Web asset not found." } }, { status: 404 });
    return new Response(name === "index.html" ? indexHtml : asset, {
      headers: {
        "cache-control": name === "index.html" ? "no-store" : "private, max-age=31536000, immutable",
        "content-type": contentTypes[extname(name)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
