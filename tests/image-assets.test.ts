import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { imageDisplayUrl } from "../src/web/image-url";

const roots: string[] = [];
const daemons: TetherDaemon[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(markdown: string) {
  const root = await realpath(await mkdtemp("/tmp/tether-images-")); roots.push(root);
  await mkdir(join(root, "docs")); await mkdir(join(root, "assets"));
  const path = join(root, "docs", "test.md"); await writeFile(path, markdown);
  await writeFile(join(root, "assets", "a b.png"), png);
  const daemon = createDaemon({ config: resolveConfig({ runtimeDir: join(root, "runtime"), configDir: join(root, "config") }) });
  daemons.push(daemon); await daemon.ready;
  const grant = await daemon.service.open(path);
  const response = await fetch(daemon.mintTicket(grant).url, { redirect: "manual" });
  const base = new URL(response.headers.get("location")!, daemon.origin);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const image = (src: string, headers: Record<string, string> = {}) => fetch(new URL(imageDisplayUrl(src), base), { headers: { cookie, ...headers } });
  return { root, path, daemon, base, cookie, image };
}

test("local inline and reference images resolve from the document, preserving Markdown and supporting revalidation", async () => {
  const source = "![inline](../assets/a%20b.png)\n\n![reference][PIC]\n\n[pic]: <../assets/a b.png>\n";
  const f = await fixture(source);
  for (const src of ["../assets/a%20b.png", "../assets/a b.png"]) {
    const response = await f.image(src);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await f.image(src, { "if-none-match": response.headers.get("etag")! })).status).toBe(304);
  }
  expect(await readFile(f.path, "utf8")).toBe(source);
});

test("image access needs a scoped session and an actual image reference, not a link or code example", async () => {
  const f = await fixture("[link](../assets/a%20b.png)\n\n```md\n![example](../assets/a%20b.png)\n```\n");
  expect((await fetch(new URL(imageDisplayUrl("../assets/a%20b.png"), f.base))).status).toBe(401);
  expect((await f.image("../assets/a%20b.png")).status).toBe(403);
  await writeFile(f.path, "![actual](../assets/a%20b.png)\n");
  expect((await f.image("../assets/a%20b.png")).status).toBe(200);
  await writeFile(f.path, "Reference removed\n");
  expect((await f.image("../assets/a%20b.png")).status).toBe(403);
});

test("missing and non-image files fail; SVG responses are sandboxed", async () => {
  const f = await fixture("![missing](none.png)\n![fake](fake.png)\n![svg](drawing.svg#shape)\n");
  await writeFile(join(f.root, "docs", "fake.png"), "not an image");
  await writeFile(join(f.root, "docs", "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  expect((await f.image("none.png")).status).toBe(404);
  expect((await f.image("fake.png")).status).toBe(415);
  const svg = await f.image("drawing.svg#shape");
  expect(svg.status).toBe(200);
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
});

test("explicit symlink images resolve, and replaced targets must still be images", async () => {
  const f = await fixture("![linked](linked.png)\n");
  const link = join(f.root, "docs", "linked.png");
  await symlink(join(f.root, "assets", "a b.png"), link);
  expect((await f.image("linked.png")).status).toBe(200);
  await unlink(link); await symlink(f.path, link);
  expect((await f.image("linked.png")).status).toBe(415);
});

test("display mapping leaves remote and uploaded URLs alone and encodes local queries once", () => {
  for (const src of ["https://example.com/a.png", "//example.com/a.png", "data:image/png;base64,AA==", "blob:https://example.com/id"]) expect(imageDisplayUrl(src)).toBe(src);
  const url = new URL(imageDisplayUrl("a%20b.svg#shape"), "http://localhost/s/id/");
  expect(url.pathname).toBe("/s/id/api/image");
  expect(url.searchParams.get("src")).toBe("a%20b.svg#shape");
  expect(url.hash).toBe("#shape");
});
