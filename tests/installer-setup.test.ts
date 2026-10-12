import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { installAgentSkill, installSelectedAgentSkills, updateAgentSkills, selectedAgentSkills, listAgentSkillReviews, readAgentSkillReview, decideAgentSkillReview } from "../src/cli/agent-skills";
import { discoverHosts, type HostInventory } from "../src/cli/host-discovery";
import { setupPaseo, removeManagedPaseo } from "../src/cli/paseo-setup";
import { resolveConfig } from "../src/server/config";
import { parseCommand } from "../src/cli/commands";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp("/tmp/tether-installer-test-"); directories.push(path); return path; }

test("named skills migrate legacy registrations and preserve independent review decisions", async () => {
  const base = await temporary(), root = join(base, "release"), config = resolveConfig({ configDir: join(base, "config") });
  const sources = ["tether-review", "tetherball"].map(id => join(root, "integrations/agents", id, "SKILL.md"));
  for (const source of sources) { await mkdir(join(source, ".."), { recursive: true }); await writeFile(source, `old ${source}`); }
  const review = await installAgentSkill(join(base, "skills"), config, root);
  const ball = await installAgentSkill(join(base, "skills"), config, root, "tetherball");
  const registry = join(config.configDir, "agent-skills.json");
  const entries = JSON.parse(await readFile(registry, "utf8")); delete entries[0].skill;
  await writeFile(registry, JSON.stringify(entries));
  await writeFile(ball.path, "My inquiry practice");
  await writeFile(sources[0]!, "new review"); await writeFile(sources[1]!, "new tetherball");
  expect(await updateAgentSkills(config, root)).toHaveLength(1);
  expect(await readFile(review.path, "utf8")).toBe("new review");
  expect(await readFile(ball.path, "utf8")).toBe("My inquiry practice");
  const pending = await listAgentSkillReviews(config);
  expect(pending).toHaveLength(1);
  const proposal = await readAgentSkillReview(config, pending[0]!.id);
  expect(proposal.proposed).toBe("new tetherball");
  await decideAgentSkillReview(config, { id: proposal.id, revision: proposal.revision, action: "keep" });
  expect(await updateAgentSkills(config, root)).toEqual([]);
  expect(await listAgentSkillReviews(config)).toEqual([]);
  expect(JSON.parse(await readFile(registry, "utf8"))[0].skill).toBe("tether-review");
  await rm(ball.path); await writeFile(sources[1]!, "third tetherball");
  await updateAgentSkills(config, root);
  expect(await Bun.file(ball.path).exists()).toBe(false);
});

test("Tetherball selection includes its dependency and validates before setup", () => {
  expect(selectedAgentSkills()).toEqual(["tether-review"]);
  expect(selectedAgentSkills("tetherball")).toEqual(["tether-review", "tetherball"]);
  expect(() => selectedAgentSkills("../other")).toThrow();
  expect(() => parseCommand(["setup", "--skills", "tetherball"])).toThrow("requires --agent-directory");
});

test("adding Tetherball preserves a registered customized dependency and its pending proposal", async () => {
  const base = await temporary(), config = resolveConfig({ configDir: join(base, "config") }), skills = join(base, "skills");
  const review = await installAgentSkill(skills, config);
  await writeFile(review.path, "My customized review workflow");
  const path = join(config.configDir, "agent-skills.json");
  const entries = JSON.parse(await readFile(path, "utf8"));
  entries[0].sha256 = "0".repeat(64); await writeFile(path, JSON.stringify(entries));
  await updateAgentSkills(config);
  const before = await listAgentSkillReviews(config);
  expect(before).toHaveLength(1);
  const installed = await installSelectedAgentSkills(skills, config, "tetherball");
  expect(installed.map(entry => entry.installed)).toEqual([false, true]);
  expect(await readFile(review.path, "utf8")).toBe("My customized review workflow");
  expect(await listAgentSkillReviews(config)).toEqual(before);
  const unregistered = join(base, "unregistered");
  await mkdir(join(unregistered, "tether-review"), { recursive: true });
  await writeFile(join(unregistered, "tether-review/SKILL.md"), "Unrelated instructions");
  await expect(installSelectedAgentSkills(unregistered, config, "tetherball")).rejects.toThrow("Existing skill differs");
});

test("host inventory distinguishes installed applications from active connections without opening them", async () => {
  const base = await temporary();
  await mkdir(join(base, "Paseo.app"));
  const calls: string[][] = [];
  const inventory = await discoverHosts({ home: base, applicationRoots: [base], which: () => null, env: {}, wave: { widgetsPath: join(base, "absent/widgets.json") }, run: async (exe, args) => { calls.push([exe, ...args]); return "0.11.2"; } });
  expect(inventory.find(host => host.id === "paseo")).toMatchObject({ installed: true, active: false, connected: false, version: "0.11.2" });
  expect(inventory.filter(host => !host.installed).map(host => host.id)).toEqual(["cmux", "wave"]);
  expect(calls).toHaveLength(1); expect(calls[0]![0]).toBe("/usr/bin/plutil");
});

test("managed Paseo setup retains stable paths and disabled state, refuses unmanaged installs, and removes only its own plugin", async () => {
  const base = await temporary(), root = join(base, "releases/one"), path = join(base, "current/integrations/paseo");
  await mkdir(join(root, "integrations/paseo"), { recursive: true }); await symlink(root, join(base, "current"));
  const host: HostInventory = { id: "paseo", cli: "/fake/paseo", version: "0.11.2", installed: true, active: false, connected: false };
  let plugins: Array<{ id: string; path: string; enabled: boolean; status: string }> = [];
  const calls: string[][] = [];
  const options = { root, home: join(base, "paseo"), run: async (_exe: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "ls") return JSON.stringify(plugins);
    if (args[1] === "install") { plugins = [{ id: "tether", path: args[2]!, enabled: true, status: "disabled" }]; return JSON.stringify(plugins[0]); }
    if (args[1] === "remove") { plugins = []; return "{}"; }
    throw new Error("Unexpected mutation");
  } };
  expect(await setupPaseo(host, options)).toMatchObject({ installed: true, path, status: "disabled" });
  expect((await setupPaseo(host, options)).installed).toBe(false);
  expect(calls.some(args => args.includes("reload") || args.includes("enable"))).toBe(false);
  expect(calls.every(args => args.includes(options.home))).toBe(true);
  plugins[0]!.path = "/personal/plugin";
  await expect(setupPaseo(host, options)).rejects.toThrow("unmanaged");
  expect(await removeManagedPaseo(host, options)).toBe(false);
  plugins[0]!.path = path;
  expect(await removeManagedPaseo(host, options)).toBe(true);
  await expect(setupPaseo({ ...host, version: "0.11.3" }, options)).rejects.toThrow("unsupported");
});

test("Tetherball offer uses registered destinations, preserves customizations, and rejects stale or arbitrary choices", async () => {
  const { tetherballOffer, decideTetherballOffer } = await import("../src/cli/agent-skills");
  const base = await temporary(), root = join(base, "release"), config = resolveConfig({ configDir: join(base, "config") });
  await mkdir(config.configDir, { recursive: true });
  for (const skill of ["tether-review", "tetherball"]) {
    const path = join(root, "integrations/agents", skill); await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), skill);
  }
  expect(await tetherballOffer(config)).toBeNull();
  expect((await tetherballOffer(config, root))!.destinations).toEqual([]);
  const review = await installAgentSkill(join(base, "skills"), config, root);
  await writeFile(review.path, "My custom review instructions");
  const offer = (await tetherballOffer(config, root))!;
  await expect(decideTetherballOffer(config, root, { action: "install", revision: offer.revision, destination: "/arbitrary" })).rejects.toThrow("registered");
  await expect(decideTetherballOffer(config, root, { action: "install", revision: "stale", destination: offer.destinations[0]!.id })).rejects.toThrow("changed");
  await decideTetherballOffer(config, root, { action: "install", revision: offer.revision, destination: offer.destinations[0]!.id });
  expect(await readFile(review.path, "utf8")).toBe("My custom review instructions");
  expect(await readFile(join(base, "skills/tetherball/SKILL.md"), "utf8")).toBe("tetherball");
  expect(await tetherballOffer(config, root)).toBeNull();
  await rm(join(base, "skills/tetherball/SKILL.md"));
  expect(await tetherballOffer(config, root)).toBeNull();
  const other = resolveConfig({ configDir: join(base, "other") }); await mkdir(other.configDir);
  const empty = (await tetherballOffer(other, root))!;
  await decideTetherballOffer(other, root, { action: "dismiss", revision: empty.revision });
  expect(await tetherballOffer(resolveConfig({ configDir: other.configDir }), root)).toBeNull();
});
