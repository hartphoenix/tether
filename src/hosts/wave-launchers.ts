import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PREVIEW_WIDGET_IDS = [
  "tether-preview-markdown", "tether-preview-recents", "tether-preview-recent-1", "tether-preview-recent-2", "tether-preview-recent-3",
] as const;

type Widgets = Record<string, unknown>;
export type WaveLauncherOptions = { widgetsPath?: string; mdreviewPath?: string; runtimePath?: string };

function paths(options: WaveLauncherOptions = {}) {
  const widgetsPath = resolve(options.widgetsPath ?? join(process.env.WAVETERM_CONFIG_DIR ?? join(homedir(), ".config", "waveterm"), "widgets.json"));
  return {
    widgetsPath,
    backupPath: `${widgetsPath}.tether-preview.backup`,
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
  return {
    "display:order": order, icon, label, description,
    blockdef: { meta: {
      view: "term", controller: "cmd", cmd: runtimePath,
      "cmd:args": [mdreviewPath, ...args], "cmd:shell": false, "cmd:jwt": true, "cmd:closeonexit": true,
      "cmd:env": { TETHER_PROFILE: "preview" },
    } },
  };
}

function previewWidgets(mdreviewPath: string, runtimePath: string): Widgets {
  return {
    "tether-preview-markdown": commandWidget("Tether Markdown (Preview)", "Open Tether’s recent Markdown picker", "file-pen", ["recents"], 1090, mdreviewPath, runtimePath),
    "tether-preview-recents": commandWidget("Tether Recents (Preview)", "Browse recent Tether Markdown files", "clock-rotate-left", ["recents"], 1091, mdreviewPath, runtimePath),
    "tether-preview-recent-1": commandWidget("Tether Recent 1 (Preview)", "Open the most recent Tether Markdown file", "file-lines", ["recent", "1"], 1092, mdreviewPath, runtimePath),
    "tether-preview-recent-2": commandWidget("Tether Recent 2 (Preview)", "Open the second recent Tether Markdown file", "file-lines", ["recent", "2"], 1093, mdreviewPath, runtimePath),
    "tether-preview-recent-3": commandWidget("Tether Recent 3 (Preview)", "Open the third recent Tether Markdown file", "file-lines", ["recent", "3"], 1094, mdreviewPath, runtimePath),
  };
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
  const installed = PREVIEW_WIDGET_IDS.filter((id) => Object.hasOwn(widgets, id));
  return { widgetsPath: resolved.widgetsPath, installed, complete: installed.length === PREVIEW_WIDGET_IDS.length };
}

export async function installWaveLaunchers(options: WaveLauncherOptions = {}) {
  const resolved = paths(options);
  const widgets = await readWidgets(resolved.widgetsPath);
  if (await stat(resolved.widgetsPath).then(() => true).catch(() => false) && !await stat(resolved.backupPath).then(() => true).catch(() => false)) {
    await copyFile(resolved.widgetsPath, resolved.backupPath);
    await chmod(resolved.backupPath, 0o600).catch(() => {});
  }
  Object.assign(widgets, previewWidgets(resolved.mdreviewPath, resolved.runtimePath));
  await atomicWrite(resolved.widgetsPath, widgets);
  return { ...(await waveLauncherStatus(options)), backupPath: resolved.backupPath };
}

export async function uninstallWaveLaunchers(options: WaveLauncherOptions = {}) {
  const resolved = paths(options);
  const widgets = await readWidgets(resolved.widgetsPath);
  for (const id of PREVIEW_WIDGET_IDS) delete widgets[id];
  await atomicWrite(resolved.widgetsPath, widgets);
  return waveLauncherStatus(options);
}
