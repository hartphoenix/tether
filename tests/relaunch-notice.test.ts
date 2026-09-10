import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderRelaunchNotice } from "../src/web/relaunch-notice";
import { createChromeControls } from "../src/web/chrome-controls";

const message = "Placement unavailable. In cmux, run: `'/path with spaces/mdreview' folio`";

test("renders a selectable command safely and preserves the alert until reload", () => {
  const dom = new JSDOM('<div id="notice"></div>');
  const notice = dom.window.document.querySelector<HTMLElement>("#notice")!;
  expect(renderRelaunchNotice(notice, "Opening…")).toBe(false);
  expect(renderRelaunchNotice(notice, "Could not open link: " + message)).toBe(true);
  expect(notice.textContent).toBe(message.replaceAll("`", ""));
  expect(notice.querySelector("code")?.textContent).toBe("'/path with spaces/mdreview' folio");
  expect(notice.getAttribute("role")).toBe("alert");
  expect(renderRelaunchNotice(notice, "Opened.")).toBe(true);
  expect(renderRelaunchNotice(notice, "")).toBe(true);
  expect(notice.querySelector("code")).not.toBeNull();
  dom.window.close();
});

test("document notices cannot time out or overwrite the relaunch alert", async () => {
  const dom = new JSDOM('<div id="notice"></div><button></button><div id="menu"></div><input><span></span>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: doc });
  try {
    const controls = createChromeControls({
      notice: doc.querySelector<HTMLElement>("#notice")!, zoomButton: doc.querySelector("button")!,
      zoomMenu: doc.querySelector<HTMLElement>("#menu")!, zoomSlider: doc.querySelector("input")!,
      zoomLabel: doc.querySelector("span")!, onZoomChange() {},
    });
    controls.setNotice("Temporary", 1);
    controls.setNotice(message, 1);
    await Bun.sleep(5);
    controls.setNotice("");
    expect(doc.querySelector("#notice code")?.textContent).toBe("'/path with spaces/mdreview' folio");
    controls.destroy();
  } finally { Object.assign(globalThis, { document: previousDocument }); dom.window.close(); }
});
