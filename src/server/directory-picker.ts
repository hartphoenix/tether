/** Native explicit destination selection; never expose a browser path picker API. */
export async function chooseImportDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("Choose an import directory through the CLI on this platform.");
  const script = `ObjC.import('AppKit'); const app=$.NSApplication.sharedApplication; app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);app.activateIgnoringOtherApps(true);const panel=$.NSOpenPanel.openPanel; panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.prompt='Import here';panel.title='Import annotations';panel.runModal===$.NSModalResponseOK?JSON.stringify(panel.URL.path.js):'null'`;
  const child = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exit) throw new Error("The directory picker could not be opened.");
  const path: unknown = JSON.parse(output);
  return typeof path === "string" ? path : null;
}
