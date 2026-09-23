import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installWaveLaunchers, WAVE_WIDGET_IDS, uninstallWaveLaunchers, waveLauncherStatus, waveInstallationDetected, syncWaveRecentLaunchers } from "../src/hosts/wave-launchers";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("atomically replaces legacy and preview widgets with canonical Tether launchers", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-wave-launchers-"));
  directories.push(directory);
  const widgetsPath = join(directory, "widgets.json");
  const original = {
    existing: { label: "Keep me" },
    "tether-recent-1": { label: "Old recent" },
    "tether-recent-2": { label: "Old recent" },
    "tether-recent-3": { label: "Old recent" },
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
  expect(Object.keys(widgets).filter((key) => WAVE_WIDGET_IDS.includes(key as typeof WAVE_WIDGET_IDS[number]))).toHaveLength(1);
  expect(widgets["tether-markdown"]).toBeUndefined();
  expect(widgets["agent-markdown"]).toBeUndefined();
  expect(widgets["tether-preview-recents"]).toBeUndefined();
  expect(widgets["tether-recents"].blockdef.meta).toMatchObject({
    controller: "shell", "cmd:jwt": true,
    "cmd:initscript": "exec '/usr/bin/env' 'TETHER_PROFILE=preview' 'TETHER_WAVE_LAUNCHER=1' '/runtime/bun' '/product/mdreview' 'folio'",
  });
  expect(widgets["tether-recents"]).toMatchObject({ label: "Tether Folio", description: "Open Tether Folio" });
  expect(Object.keys(widgets).filter(key => key.startsWith("tether-recent-"))).toEqual([]);
  await syncWaveRecentLaunchers(options.recents, options);
  expect((await waveLauncherStatus(options)).recentCount).toBe(0);
  await installWaveLaunchers(options);
  expect(JSON.parse(await readFile(installed.backupPath, "utf8"))).toEqual(original);
  const removed = await uninstallWaveLaunchers(options);
  expect(removed.complete).toBe(false);
  expect(JSON.parse(await readFile(widgetsPath, "utf8"))).toEqual({ existing: original.existing });
  expect((await waveLauncherStatus(options)).installed).toEqual([]);
});

test("detects Wave configuration or application without inventing a Wave installation", async () => {
  const directory = await mkdtemp("/tmp/tether-wave-detection-"); directories.push(directory);
  const widgetsPath = join(directory, "config/widgets.json");
  const application = join(directory, "Wave.app");
  expect(await waveInstallationDetected({ widgetsPath })).toBe(false);
  await mkdir(application);
  expect(await waveInstallationDetected({ widgetsPath, installationPaths: [application] })).toBe(true);
  await mkdir(join(directory, "config"));
  expect(await waveInstallationDetected({ widgetsPath })).toBe(true);
});

test("plain setup adds only Folio when Wave is detected, without changing the launch host", async () => {
  const { runCli } = await import("../src/cli/main");
  const { resolveConfig } = await import("../src/server/config");
  const { createDaemon } = await import("../src/server/server");
  const directory = await mkdtemp("/tmp/tether-wave-setup-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "tether"), runtimeDir: join(directory, "runtime") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000 });
  await daemon.ready;
  try {
    const widgetsPath = join(directory, "wave/widgets.json");
    const dependencies = { config, waveLaunchers: { widgetsPath } };
    const absent = await runCli(["setup", "--host", "browser", "--no-open"], dependencies);
    expect(absent.response).toMatchObject({ ok: true, data: { hostPreference: "browser" } });
    expect(await Bun.file(widgetsPath).exists()).toBe(false);
    await mkdir(join(directory, "wave"));
    await writeFile(widgetsPath, JSON.stringify({ unrelated: { label: "Keep" }, "tether-recent-1": {} }));
    const found = await runCli(["setup", "--no-open"], dependencies);
    expect(found.response).toMatchObject({ ok: true, data: { hostPreference: "browser", wave: { complete: true, recentCount: 0 } } });
    const widgets = JSON.parse(await readFile(widgetsPath, "utf8"));
    expect(Object.keys(widgets).sort()).toEqual(["tether-recents", "unrelated"]);
    expect(widgets["tether-recents"].label).toBe("Tether Folio");
  } finally { await daemon.stop(); }
});
