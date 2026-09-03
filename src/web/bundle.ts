import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

export type WebResponder = (request: Request) => Response;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Build the browser application in memory once for a source-checkout daemon. */
export async function createWebBundleResponder(): Promise<WebResponder> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./index.html", import.meta.url))],
    minify: true,
    naming: "[name]-[hash].[ext]",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(`Unable to build the Tether web application: ${result.logs.map(String).join("\n")}`);
  }

  const assets = new Map(result.outputs.map((output) => [basename(output.path), output]));
  const index = result.outputs.find((output) => extname(output.path) === ".html");
  if (!index) throw new Error("The Tether web build did not produce an HTML entry point.");
  assets.set("index.html", index);
  return (request) => {
    const pathname = new URL(request.url).pathname;
    const name = pathname.endsWith("/") ? "index.html" : pathname.split("/").at(-1)!;
    const asset = assets.get(name);
    if (!asset) return Response.json({ error: { code: "not_found", message: "Web asset not found." } }, { status: 404 });
    return new Response(asset, {
      headers: {
        "cache-control": name === "index.html" ? "no-store" : "private, max-age=31536000, immutable",
        "content-type": contentTypes[extname(name)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
