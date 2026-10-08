import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SetupAttempts } from "../src/remote/setup-attempts";
import { Machines } from "../src/storage/machines";
import { formatMachinePath } from "../src/shared/machine-path";

test("setup records cmux and Wave choices without weakening file-machine requirements", () => {
  const db = new Database(":memory:");
  try {
    const attempts = new SetupAttempts(db), machineId = crypto.randomUUID();
    for (const access of ["cmux", "wave"] as const) {
      const answers = { hub: "Mac", machine: "Mac", machineId, access, qualifyPaths: true, internet: false, initialSetup: true };
      const attempt = attempts.save(answers);
      expect(attempt.answers).toEqual(answers);
      expect(() => attempts.save({ ...answers, machine: "" })).toThrow("selected file machine");
      expect(attempts.verified(attempt.id, { machineId }).answers.machineId).toBe(machineId);
    }
  } finally { db.close(); }
});

test("setup reporting requires a bound owner approval and cannot self-certify readiness", async () => {
  const db = new Database(":memory:");
  try {
    const attempts = new SetupAttempts(db);
    const attempt = attempts.save({ hub: "Mac", machine: "Ubuntu", access: "paseo", qualifyPaths: false, internet: false });
    const capability = "a".repeat(43);
    const send = (path: string, body: object, token = capability) => attempts.handle(new Request(`https://test.example/setup/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ attemptId: attempt.id, ...body }) }));
    const contact = await (await send("contact", { name: "Ubuntu setup", capability }))!.json();
    expect(contact.capability).toBeUndefined();
    expect((await (await send("contact", { name: "Ubuntu setup", capability }))!.json()).code).toBe(contact.code);
    await expect(send("report", { phase: "installed", report: "ready" })).rejects.toThrow("Approve");
    const restarted = new SetupAttempts(db); restarted.approve(attempt.id, contact.code);
    await expect(send("report", { phase: "verified", report: "ready" })).rejects.toThrow("supported setup phase");
    expect(await (await send("report", { phase: "installed", report: "Installed the connector." }))!.json()).toEqual({ reported: true, verified: false });
    expect(attempts.get(attempt.id).report).toBe("Installed the connector.");
    expect(JSON.stringify(db.query("SELECT * FROM setup_attempts").all())).not.toContain(capability);
    attempts.cancelAll();
    await expect(send("status", {})).rejects.toThrow("Restart");
  } finally { db.close(); }
});

test("machine names are unique, preferences follow identity, and plain paths remain default", () => {
  const db = new Database(":memory:");
  try {
    const machines = new Machines(db), id = crypto.randomUUID(), other = crypto.randomUUID();
    machines.set(id, "Phoenix");
    expect(formatMachinePath("/notes.md", machines.get(id))).toBe("/notes.md");
    expect(() => machines.set(other, "phoenix")).toThrow("already uses");
    machines.set(id, "phoenix-bot", true);
    expect(formatMachinePath("/notes.md", new Machines(db).get(id))).toBe("phoenix-bot:/notes.md");
    expect(() => machines.set(other, "bad:name")).toThrow();
  } finally { db.close(); }
});
