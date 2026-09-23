import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { discoverVerifiedRelease, withVerifiedRelease } from "../src/releases/verified-update";
import { signedRepository } from "./fixtures/signed-repository";

test("Bun verifies signed metadata and archives, persists rollback state, and follows root rotation", async () => {
  const f = await signedRepository();
  try {
    expect((await discoverVerifiedRelease(f.root))?.version).toBe("0.2.0");
    await withVerifiedRelease(f.root, async (release, download) => {
      expect(release?.tag).toBe("v0.2.0");
      expect(await readFile(await download(), "utf8")).toBe("verified archive fixture");
    });
    const old = new Map(f.files);
    f.rotate(); f.publish("0.3.0");
    expect((await discoverVerifiedRelease(f.root))?.version).toBe("0.3.0");
    for (const [path, content] of old) f.files.set(path, content);
    await expect(discoverVerifiedRelease(f.root)).rejects.toThrow();
  } finally { await f.close(); }
});

test("invalid signatures, expired metadata, wrong platform and tampered downloads fail before candidate execution", async () => {
  for (const failure of ["signature", "expired", "platform", "architecture", "archive", "missing"] as const) {
    const f = await signedRepository(); let executed = false;
    try {
      if (failure === "signature") {
        const data = JSON.parse(f.files.get("metadata/timestamp.json") as string); data.signatures[0].sig = "00".repeat(64); f.files.set("metadata/timestamp.json", JSON.stringify(data));
      } else if (failure === "expired") f.publish("0.2.0", { expires: "2000-01-01T00:00:00Z" });
      else if (failure === "platform") f.publish("0.2.0", { platform: "not-macos" });
      else if (failure === "architecture") f.publish("0.2.0", { architecture: "other" });
      else if (failure === "archive") f.files.set(`targets/tether-${process.platform}-${process.arch}.tar.gz`, Buffer.from("unverified archive fixture"));
      else f.files.delete("metadata/targets.json");
      await expect(withVerifiedRelease(f.root, async (_, download) => { await download(); executed = true; })).rejects.toThrow();
      expect(executed).toBe(false);
    } finally { await f.close(); }
  }
});
