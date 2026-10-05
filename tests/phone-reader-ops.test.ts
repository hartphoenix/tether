import { describe, expect, test } from "bun:test";
import { launchAgent, transition, waitForUnload } from "../scripts/phone-reader-ctl";
import { operationsHealth } from "../src/remote/operations-health";

describe("phone reader operations", () => {
  test("health identifies each local surface without disclosing state", async () => {
    for (const [surface, port] of [["reader", 8413], ["approval", 8414]] as const) {
      const response = operationsHealth(new Request(`http://127.0.0.1:${port}/health`), surface, "abc");
      expect(await response!.json()).toEqual({ service: "tether-phone-reader", surface, revision: "abc" });
      expect(response!.headers.get("cache-control")).toBe("no-store");
      expect(operationsHealth(new Request("https://reader.example/health"), surface, "abc")).toBeUndefined();
      expect(operationsHealth(new Request(`http://127.0.0.1:${port}/health`, { method: "POST" }), surface, "abc")).toBeUndefined();
    }
  });
  test("supervisor uses exact arguments and never enables enrollment", () => {
    const plist = launchAgent({ document: "/a & b/doc.md", stateDir: "/private/state", owner: "owner@example.com",
      readerOrigin: "https://reader.example", approvalOrigin: "https://approval.example", bun: "/bin/bun" }, "/ops space");
    expect(plist).toContain("/a &amp; b/doc.md");
    expect(plist).toContain("/ops space/current/scripts/phone-reader.ts");
    expect(plist).not.toContain("--enroll");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
  });
  test("waits for launchd to remove an exiting job even after its ports close", async () => {
    const observations = [true, true, false];
    let sleeps = 0;
    await waitForUnload(async () => observations.shift()!, async () => { sleeps++; });
    expect(observations).toEqual([]);
    expect(sleeps).toBe(2);
  });
  test("a job that cannot unload blocks replacement instead of skipping bootstrap", async () => {
    let probes = 0;
    await expect(waitForUnload(async () => { probes++; return true; }, async () => {})).rejects.toThrow("refusing to start a replacement");
    expect(probes).toBe(200);
  });
  function fixture(failures: number) {
    let selected = "old", attempts = 0;
    const calls: string[] = [];
    return { calls, ops: {
      async stop() { calls.push("stop"); },
      async point(path: string) { selected = path; calls.push(`point:${path}`); },
      async start() { calls.push(`start:${selected}`); if (++attempts <= failures) throw new Error("unhealthy"); },
    } };
  }
  test("healthy deploy preserves new code", async () => {
    const { calls, ops } = fixture(0); await transition("new", "old", ops);
    expect(calls).toEqual(["stop", "point:new", "start:new"]);
  });
  test("failed health rolls back and verifies the previous release", async () => {
    const { calls, ops } = fixture(1);
    await expect(transition("new", "old", ops)).rejects.toThrow("previous release restored and healthy");
    expect(calls).toEqual(["stop", "point:new", "start:new", "stop", "point:old", "start:old"]);
  });
  test("rollback failure is distinguished from recovery", async () => {
    const { ops } = fixture(2);
    await expect(transition("new", "old", ops)).rejects.toThrow("Deploy and rollback failed");
  });
  test("failure to stop leaves the code pointer untouched", async () => {
    const { calls, ops } = fixture(0);
    ops.stop = async () => { throw new Error("occupied"); };
    await expect(transition("new", "old", ops)).rejects.toThrow("occupied");
    expect(calls).toEqual([]);
  });
});
