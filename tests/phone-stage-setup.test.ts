import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPhoneStage, phoneStageService } from "../scripts/setup-phone-stage";

test("staging setup preserves workspace settings and migrates the wrapper command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stage-setup-"));
  try {
    const config = { worktree: { setup: "echo setup" }, scripts: { other: { command: "echo other" }, phone: { type: "service", command: "bun run stage:phone", port: 9876 } } };
    await writeFile(join(directory, "paseo.json"), JSON.stringify(config));
    await setupPhoneStage(directory);
    const result = JSON.parse(await readFile(join(directory, "paseo.json"), "utf8"));
    expect(result).toEqual({ ...config, scripts: { ...config.scripts, phone: { ...phoneStageService, port: 9876 } } });
    await setupPhoneStage(directory);
    expect(JSON.parse(await readFile(join(directory, "paseo.json"), "utf8"))).toEqual(result);
  } finally { await rm(directory, { recursive: true }); }
});
test("staging setup creates a missing configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stage-setup-"));
  try {
    await setupPhoneStage(directory);
    expect(JSON.parse(await readFile(join(directory, "paseo.json"), "utf8"))).toEqual({ scripts: { phone: phoneStageService } });
  } finally { await rm(directory, { recursive: true }); }
});
test("staging setup refuses to replace a different phone service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stage-setup-"));
  try {
    const source = JSON.stringify({ scripts: { phone: { type: "service", command: "my-existing-server" } } });
    await writeFile(join(directory, "paseo.json"), source);
    await expect(setupPhoneStage(directory)).rejects.toThrow("already exists");
    expect(await readFile(join(directory, "paseo.json"), "utf8")).toBe(source);
  } finally { await rm(directory, { recursive: true }); }
});


test("desktop Folio staging requires an explicit profile and keeps it on subsequent setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stage-setup-"));
  try {
    await setupPhoneStage(directory, "preview");
    await setupPhoneStage(directory);
    const config = JSON.parse(await readFile(join(directory, "paseo.json"), "utf8"));
    expect(config.scripts.phone.command).toBe(phoneStageService.command + " --folio-profile preview");
    await expect(setupPhoneStage(directory, "bad;command")).rejects.toThrow("Invalid Folio profile");
  } finally { await rm(directory, { recursive: true }); }
});
