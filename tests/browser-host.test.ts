import { expect, test } from "bun:test";
import { BrowserHostAdapter, platformOpenCommand } from "../src/hosts/browser";

test("reports honest system-browser capabilities and uses an injectable opener", async () => {
  const opened: string[] = [];
  const adapter = new BrowserHostAdapter({ open: async (url) => { opened.push(url); } });
  expect(await adapter.detect()).toBe(true);
  expect(adapter.capabilities()).toEqual({
    embeddedBrowser: false,
    hiddenNavigation: false,
    widgetInstallation: false,
    fileNavigatorHook: false,
    revealFile: process.platform === "darwin",
  });
  expect(await adapter.openView({ url: "http://127.0.0.1:1234/launch?ticket=one", kind: "document", focus: true })).toEqual({ launchConsumed: true });
  await adapter.openExternal("https://example.com");
  if (process.platform === "darwin") await adapter.revealFile("/tmp/example.md");
  expect(opened).toEqual(["http://127.0.0.1:1234/launch?ticket=one", "https://example.com", ...(process.platform === "darwin" ? ["/tmp/example.md"] : [])]);
  expect(platformOpenCommand("https://example.com").at(-1)).toBe("https://example.com");
});

test("filters credentials from browser command environments", async () => {
  let environment: NodeJS.ProcessEnv | undefined;
  const adapter = new BrowserHostAdapter({ run: async (_command, env) => { environment = env; } });
  await adapter.openView({ url: "http://127.0.0.1:1234/", kind: "document", focus: true });
  expect(environment).toBeDefined();
  expect(environment).not.toHaveProperty("WAVETERM_JWT");
  expect(environment).not.toHaveProperty("GH_TOKEN");
});
