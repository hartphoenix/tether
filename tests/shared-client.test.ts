import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { readSharedCredential, sharedRequest, writeSharedCredential } from "../src/remote/shared-client";
import type { SharedCredential } from "../src/remote/shared-auth";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const credential: SharedCredential = { origin: "https://library.example.test", clientId: "client-id", machineId: null, token: "a".repeat(43), expiresAt: Date.now() + 86_400_000 };
async function scratch() { const directory = await mkdtemp("/tmp/tether-client-"); directories.push(directory); return directory; }

test("private credentials are atomically stored with owner-only access and reject symlinks", async () => {
  const directory = await scratch(), path = join(directory, "connection.json");
  await writeSharedCredential(path, credential);
  expect((await stat(path)).mode & 0o777).toBe(0o600); expect(await readSharedCredential(path)).toEqual(credential);
  const link = join(directory, "link.json"); await symlink(path, link);
  await expect(readSharedCredential(link)).rejects.toThrow();
  await chmod(path, 0o644); await expect(readSharedCredential(path)).rejects.toMatchObject({ code: "credential_permissions" });
  await writeSharedCredential(path, { ...credential, origin: "https://relocated.example.test" });
  expect((await stat(path)).mode & 0o777).toBe(0o600); expect(JSON.parse(await readFile(path, "utf8")).origin).toBe("https://relocated.example.test");
});

test("remote requests use HTTPS bearer headers and never follow endpoint redirects", async () => {
  const request = (async (url: string, options: RequestInit) => {
    expect(url).toBe("https://library.example.test/api/shared/document.read"); expect(options.redirect).toBe("manual");
    expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${credential.token}`);
    return new Response(null, { status: 307, headers: { location: "https://attacker.test" } });
  }) as typeof fetch;
  await expect(sharedRequest(credential, "document.read", { documentId: "document" }, { fetch: request })).rejects.toMatchObject({ code: "endpoint_changed" });
  await expect(sharedRequest({ ...credential, origin: "http://library.example.test" }, "document.read", {})).rejects.toMatchObject({ code: "invalid_origin" });
});

test("structured conflicts and lost mutation outcomes remain distinct", async () => {
  const conflict = (async () => Response.json({ error: { code: "revision_conflict", message: "Changed", details: { actual: "new" } } }, { status: 409 })) as unknown as typeof fetch;
  await expect(sharedRequest(credential, "document.save", {}, { fetch: conflict })).rejects.toMatchObject({ code: "revision_conflict", status: 409, details: { actual: "new" } });
  const lost = (async () => { throw new Error("network unavailable"); }) as unknown as typeof fetch;
  await expect(sharedRequest(credential, "document.save", {}, { fetch: lost })).rejects.toMatchObject({ code: "save_unconfirmed", details: { outcome: "outcome_unknown" } });
  await expect(sharedRequest(credential, "document.read", {}, { fetch: lost })).rejects.toMatchObject({ code: "service_unreachable", details: { outcome: "not_applied" } });
});
