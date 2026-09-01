import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { basename } from "node:path";
import type { RecentEntry } from "../recents/registry";

export const WAVE_WIDGET_IDS = [
  "tether-markdown", "tether-recents", "tether-recent-1", "tether-recent-2", "tether-recent-3",
] as const;
export const RETIRED_WAVE_WIDGET_IDS = [
  "tether-preview-markdown", "tether-preview-recents", "tether-preview-recent-1", "tether-preview-recent-2", "tether-preview-recent-3",
  "agent-markdown", "agent-recent-queue", "agent-recent-1", "agent-recent-2", "agent-recent-3", "agent-recent-4", "agent-recent-5",
] as const;

type Widgets = Record<string, unknown>;
export type WaveLauncherOptions = { widgetsPath?: string; mdreviewPath?: string; runtimePath?: string; recents?: RecentEntry[] };

function paths(options: WaveLauncherOptions = {}) {
  const widgetsPath = resolve(options.widgetsPath ?? join(process.env.WAVETERM_CONFIG_DIR ?? join(homedir(), ".config", "waveterm"), "widgets.json"));
  return {
    widgetsPath,
    backupPath: `${widgetsPath}.tether-cutover.backup`,
    mdreviewPath: resolve(options.mdreviewPath ?? join(import.meta.dir, "..", "..", "mdreview")),
    runtimePath: options.runtimePath ?? process.execPath,
  };
}

async function readWidgets(path: string): Promise<Widgets> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wave widgets.json must contain a JSON object.");
    return value as Widgets;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

function commandWidget(label: string, description: string, icon: string, args: string[], order: number, mdreviewPath: string, runtimePath: string) {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = ["/usr/bin/env", "TETHER_PROFILE=preview", "TETHER_WAVE_LAUNCHER=1", runtimePath, mdreviewPath, ...args].map(quote).join(" ");
  return {
    "display:order": order, icon, label, description,
    blockdef: { meta: {
      view: "term", controller: "shell", "cmd:initscript": `exec ${command}`, "cmd:jwt": true,
    } },
  };
}

function tetherWidgets(mdreviewPath: string, runtimePath: string, recents: RecentEntry[] = []): Widgets {
  const widgets: Widgets = {
    "tether-markdown": commandWidget("Tether Markdown", "Open Tether’s recent Markdown picker", "file-pen", ["recents"], 1090, mdreviewPath, runtimePath),
    "tether-recents": commandWidget("Tether Recents", "Browse recent Tether Markdown files", "clock-rotate-left", ["recents"], 1091, mdreviewPath, runtimePath),
  };
  recents.slice(0, 3).forEach((entry, index) => {
    widgets[`tether-recent-${index + 1}`] = commandWidget(basename(entry.path), entry.path, "file-lines", ["recent", String(index + 1)], 1092 + index, mdreviewPath, runtimePath);
  });
  return widgets;
}

async function atomicWrite(path: string, value: Widgets): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mode = await stat(path).then((value) => value.mode & 0o777).catch(() => 0o600);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode).catch(() => {});
  await rename(temporary, path);
}

export async function waveLauncherStatus(options: WaveLauncherOptions = {}) {
  const resolved = paths(options);
  const widgets = await readWidgets(resolved.widgetsPath);
  const installed = WAVE_WIDGET_IDS.filter((id) => Object.hasOwn(widgets, id));
  const recentCount = installed.filter((id) => id.startsWith("tether-recent-")).length;
  const complete = installed.includes("tether-markdown") && installed.includes("tether-recents");
  return { widgetsPath: resolved.widgetsPath, installed, recentCount, complete };
}

export async function installWaveLaunchers(options: WaveLauncherOptions = {}) {
  const resolved = paths(options);
  const widgets = await readWidgets(resolved.widgetsPath);
  if (await stat(resolved.widgetsPath).then(() => true).catch(() => false) && !await stat(resolved.backupPath).then(() => true).catch(() => false)) {
    await copyFile(resolved.widgetsPath, resolved.backupPath);
    await chmod(resolved.backupPath, 0o600).catch(() => {});
  }
  for (const id of [...WAVE_WIDGET_IDS, ...RETIRED_WAVE_WIDGET_IDS]) delete widgets[id];
  Object.assign(widgets, tetherWidgets(resolved.mdreviewPath, resolved.runtimePath, options.recents));
  await atomicWrite(resolved.widgetsPath, widgets);
  return { ...(await waveLauncherStatus(options)), backupPath: resolved.backupPath };
}

export async function syncWaveRecentLaunchers(entries: RecentEntry[], options: WaveLauncherOptions = {}) {
  return installWaveLaunchers({ ...options, recents: entries });
}

export async function uninstallWaveLaunchers(options: WaveLauncherOptions = {}) {
  const resolved = paths(options);
  const widgets = await readWidgets(resolved.widgetsPath);
  for (const id of [...WAVE_WIDGET_IDS, ...RETIRED_WAVE_WIDGET_IDS]) delete widgets[id];
  await atomicWrite(resolved.widgetsPath, widgets);
  return waveLauncherStatus(options);
}
