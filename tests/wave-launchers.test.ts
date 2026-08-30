import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installWaveLaunchers, PREVIEW_WIDGET_IDS, uninstallWaveLaunchers, waveLauncherStatus } from "../src/hosts/wave-launchers";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("installs and removes only distinct preview widgets with an atomic backup", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-wave-launchers-"));
  directories.push(directory);
  const widgetsPath = join(directory, "widgets.json");
  const original = { existing: { label: "Keep me" } };
  await writeFile(widgetsPath, JSON.stringify(original));
  const options = { widgetsPath, mdreviewPath: "/product/mdreview", runtimePath: "/runtime/bun" };
  const installed = await installWaveLaunchers(options);
  expect(installed.complete).toBe(true);
  expect(JSON.parse(await readFile(installed.backupPath, "utf8"))).toEqual(original);
  const widgets = JSON.parse(await readFile(widgetsPath, "utf8")) as Record<string, any>;
  expect(widgets.existing).toEqual(original.existing);
  expect(Object.keys(widgets).filter((key) => PREVIEW_WIDGET_IDS.includes(key as typeof PREVIEW_WIDGET_IDS[number]))).toHaveLength(5);
  expect(widgets["tether-preview-recents"].blockdef.meta).toMatchObject({
    controller: "cmd", cmd: "/runtime/bun", "cmd:args": ["/product/mdreview", "recents"], "cmd:shell": false,
    "cmd:jwt": true, "cmd:closeonexit": true, "cmd:env": { TETHER_PROFILE: "preview" },
  });
  await installWaveLaunchers(options);
  expect(JSON.parse(await readFile(installed.backupPath, "utf8"))).toEqual(original);
  const removed = await uninstallWaveLaunchers(options);
  expect(removed.complete).toBe(false);
  expect(JSON.parse(await readFile(widgetsPath, "utf8"))).toEqual(original);
  expect((await waveLauncherStatus(options)).installed).toEqual([]);
});
