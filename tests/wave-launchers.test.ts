import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installWaveLaunchers, WAVE_WIDGET_IDS, uninstallWaveLaunchers, waveLauncherStatus } from "../src/hosts/wave-launchers";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("atomically replaces legacy and preview widgets with canonical Tether launchers", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-wave-launchers-"));
  directories.push(directory);
  const widgetsPath = join(directory, "widgets.json");
  const original = {
    existing: { label: "Keep me" },
    "agent-markdown": { label: "Legacy Markdown" },
    "agent-recent-1": { label: "Legacy Recent" },
    "tether-preview-recents": { label: "Preview Recents" },
  };
  await writeFile(widgetsPath, JSON.stringify(original));
  const options = {
    widgetsPath, mdreviewPath: "/product/mdreview", runtimePath: "/runtime/bun",
    recents: [
      { path: "/docs/alpha.md", createdAt: 3 },
      { path: "/docs/beta.md", createdAt: 2 },
      { path: "/docs/gamma.md", createdAt: 1 },
    ],
  };
  const installed = await installWaveLaunchers(options);
  expect(installed.complete).toBe(true);
  expect(JSON.parse(await readFile(installed.backupPath, "utf8"))).toEqual(original);
  const widgets = JSON.parse(await readFile(widgetsPath, "utf8")) as Record<string, any>;
  expect(widgets.existing).toEqual(original.existing);
  expect(Object.keys(widgets).filter((key) => WAVE_WIDGET_IDS.includes(key as typeof WAVE_WIDGET_IDS[number]))).toHaveLength(4);
  expect(widgets["tether-markdown"]).toBeUndefined();
  expect(widgets["agent-markdown"]).toBeUndefined();
  expect(widgets["tether-preview-recents"]).toBeUndefined();
  expect(widgets["tether-recents"].blockdef.meta).toMatchObject({
    controller: "shell", "cmd:jwt": true,
    "cmd:initscript": "exec '/usr/bin/env' 'TETHER_PROFILE=preview' 'TETHER_WAVE_LAUNCHER=1' '/runtime/bun' '/product/mdreview' 'folio'",
  });
  expect(widgets["tether-recents"]).toMatchObject({ label: "Open Tether", description: "Open Tether Folio" });
  expect(widgets["tether-recent-1"]).toMatchObject({ label: "alpha.md", description: "/docs/alpha.md" });
  await installWaveLaunchers(options);
  expect(JSON.parse(await readFile(installed.backupPath, "utf8"))).toEqual(original);
  const removed = await uninstallWaveLaunchers(options);
  expect(removed.complete).toBe(false);
  expect(JSON.parse(await readFile(widgetsPath, "utf8"))).toEqual({ existing: original.existing });
  expect((await waveLauncherStatus(options)).installed).toEqual([]);
});
