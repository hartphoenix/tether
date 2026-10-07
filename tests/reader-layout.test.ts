import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountReaderLayout } from "../src/web/reader-layout";

test("reader controls move between narrow and wide layouts without duplicate or focusable inactive controls", () => {
  const dom = new JSDOM('<div id="home"><button id="comment"></button><div id="theme"></div><button id="source"></button></div><nav id="controls"></nav><button id="phone-folio"></button><div id="mobile-folio"></div>', { runScripts: "outside-only" });
  const win = dom.window; let update = () => {}; let closes = 0;
  const query = { matches: false, addEventListener: (_: string, callback: () => void) => { update = callback; }, removeEventListener() {} };
  Object.assign(win, { matchMedia: () => query });
  (win as any).onClose = () => closes++;
  win.eval(`(${mountReaderLayout.toString()})({controls:document.querySelector('#controls'),comment:document.querySelector('#comment'),theme:document.querySelector('#theme'),extras:[document.querySelector('#source')],closeFolio:onClose})`);
  const controls = win.document.querySelector<HTMLElement>("#controls")!;
  expect(controls.hidden).toBe(true); expect(controls.inert).toBe(true);
  query.matches = true; update();
  expect(controls.hidden).toBe(false); expect(controls.querySelectorAll("#comment,#source")).toHaveLength(2);
  query.matches = false; update();
  expect(win.document.querySelectorAll("#comment")).toHaveLength(1);
  expect(win.document.querySelector("#comment")!.parentElement!.id).toBe("home");
  expect(controls.inert).toBe(true); expect(closes).toBe(2); dom.window.close();
});
