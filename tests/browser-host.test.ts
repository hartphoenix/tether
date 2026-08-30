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
    revealFile: false,
  });
  await adapter.openView("http://127.0.0.1:1234/launch?ticket=one");
  await adapter.openExternal("https://example.com");
  expect(opened).toEqual(["http://127.0.0.1:1234/launch?ticket=one", "https://example.com"]);
  expect(platformOpenCommand("https://example.com").at(-1)).toBe("https://example.com");
});

test("filters credentials from browser command environments", async () => {
  let environment: NodeJS.ProcessEnv | undefined;
  const adapter = new BrowserHostAdapter({ run: async (_command, env) => { environment = env; } });
  await adapter.openView("http://127.0.0.1:1234/");
  expect(environment).toBeDefined();
  expect(environment).not.toHaveProperty("WAVETERM_JWT");
  expect(environment).not.toHaveProperty("GH_TOKEN");
});
