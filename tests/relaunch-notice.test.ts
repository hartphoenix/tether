import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderRelaunchNotice } from "../src/web/relaunch-notice";

const command = "'/path with spaces/mdreview' folio";
const message = "Placement unavailable. In cmux, run: `" + command + "`";

test("shows a viewport-centered modal, copies with confirmation, and restores focus on dismissal", async () => {
  const dom = new JSDOM('<button id="source">Open</button><div id="notice"></div>');
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value: function(this: HTMLDialogElement) { this.open = true; } });
  const doc = dom.window.document;
  const source = doc.querySelector<HTMLButtonElement>("#source")!;
  const notice = doc.querySelector<HTMLElement>("#notice")!;
  source.focus();
  let copied = "";
  let finish!: () => void;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: {
    writeText: (text: string) => new Promise<void>(resolve => { copied = text; finish = resolve; }),
  } });
  expect(renderRelaunchNotice(notice, "Opening…")).toBe(false);
  expect(renderRelaunchNotice(notice, "Could not open link: " + message)).toBe(true);
  const dialog = doc.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.style.position).toBe("fixed");
  expect(dialog.style.margin).toBe("auto");
  expect(dialog.querySelector("code")?.textContent).toBe(command);
  expect(notice.textContent).toBe("");
  const [copy, close] = dialog.querySelectorAll("button");
  copy!.click();
  expect(copied).toBe(command);
  expect(copy!.textContent).toBe("Copy");
  finish();
  await Bun.sleep(0);
  expect(copy!.textContent).toBe("Copied");
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Copied");
  expect(renderRelaunchNotice(notice, "Opened.")).toBe(false);
  expect(renderRelaunchNotice(notice, message)).toBe(true);
  expect(doc.querySelectorAll("dialog")).toHaveLength(1);
  close!.click();
  expect(doc.querySelector("dialog")).toBeNull();
  expect(doc.activeElement).toBe(source);
  renderRelaunchNotice(notice, message);
  doc.querySelector("dialog")!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
  expect(doc.querySelector("dialog")).toBeNull();
  dom.window.close();
});

test("clipboard failure leaves the command selectable and never claims success", async () => {
  const dom = new JSDOM('<div id="notice"></div>');
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.navigator, "clipboard", { value: {
    writeText: async () => { throw new Error("Denied"); },
  } });
  renderRelaunchNotice(dom.window.document.querySelector("div")!, message);
  const dialog = dom.window.document.querySelector("dialog")!;
  dialog.querySelector("button")!.click();
  await Bun.sleep(0);
  expect(dialog.querySelector("button")!.textContent).toBe("Copy");
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain("Could not copy");
  expect(dialog.querySelector("code")!.style.userSelect).toBe("all");
  dom.window.close();
});
