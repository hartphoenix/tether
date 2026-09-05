import { resolve } from "node:path";

export type TrashCommandRunner = (command: string[]) => Promise<void>;
export type PickerCommandRunner = (command: string[]) => Promise<string>;

async function runCommand(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode === 0) return;
  const message = child.stderr ? (await new Response(child.stderr).text()).trim() : "";
  throw new Error(message || `${command[0]} exited with status ${exitCode}`);
}

async function runForOutput(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command[0]} exited with status ${exitCode}`);
  return stdout.trim();
}

const PICK_MARKDOWN_SCRIPT = `function run() {
ObjC.import("AppKit");
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
app.activateIgnoringOtherApps(true);
const panel = $.NSOpenPanel.openPanel;
panel.title = "Add Markdown Files";
panel.prompt = "Add Files";
panel.canChooseFiles = true;
panel.canChooseDirectories = false;
panel.allowsMultipleSelection = true;
panel.resolvesAliases = true;
panel.allowedFileTypes = ["md", "markdown"];
if (panel.runModal !== $.NSModalResponseOK) {
  return JSON.stringify([]);
} else {
  return JSON.stringify(panel.URLs.js.map((url) => url.path.js));
}
}`;

/** Ask macOS for one or more existing Markdown paths without exposing a broad path API to the page. */
export async function pickMarkdownFiles(run: PickerCommandRunner = runForOutput): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("The native Markdown picker is currently supported only on macOS.");
  const output = await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", PICK_MARKDOWN_SCRIPT]);
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new Error("The native Markdown picker returned an invalid response."); }
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path)) {
    throw new Error("The native Markdown picker returned invalid paths.");
  }
  return value;
}

/** Move one explicitly authorized file to the macOS Trash. */
export async function moveToTrash(path: string, run: TrashCommandRunner = runCommand): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Move to Trash is currently supported only on macOS.");
  await run([
    "osascript",
    "-e", "on run argv",
    "-e", "set targetFile to POSIX file (item 1 of argv) as alias",
    "-e", "tell application \"Finder\" to delete targetFile",
    "-e", "end run",
    resolve(path),
  ]);
}
