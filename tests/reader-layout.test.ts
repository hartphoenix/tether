import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mobileClient, mountReaderLayout } from "../src/web/reader-layout";

test("any mobile signal selects mobile; absent signals select desktop", () => {
  expect(mobileClient({ userAgent: "Macintosh" }, false)).toBe(false);
  expect(mobileClient({ userAgent: "Windows", userAgentData: { mobile: false } }, true)).toBe(true);
  expect(mobileClient({ userAgent: "Macintosh", userAgentData: { mobile: true } }, false)).toBe(true);
  for (const userAgent of ["iPhone", "iPad", "Android", "Mobile"]) {
    expect(mobileClient({ userAgent, userAgentData: { mobile: false } }, false)).toBe(true);
  }
});

function fixture(preference?: string) {
  const dom = new JSDOM('<div id="home"><button id="comment"></button><div id="theme"></div><button id="source"></button></div><nav id="controls"></nav><button id="phone-folio"></button><div id="mobile-folio"></div>', { url: "http://localhost", runScripts: "outside-only" });
  const win = dom.window; let update = () => {};
  const query = { matches: false, addEventListener: (_: string, callback: () => void) => { update = callback; }, removeEventListener() {} };
  Object.assign(win, { matchMedia: (value: string) => { expect(value).toBe("(pointer: coarse) and (hover: none)"); return query; } });
  if (preference) win.localStorage.setItem("tether.readerMode", preference);
  win.eval(`const mobileClient = ${mobileClient.toString()}; window.layout = (${mountReaderLayout.toString()})({controls:document.querySelector('#controls'),comment:document.querySelector('#comment'),theme:document.querySelector('#theme'),extras:[document.querySelector('#source')],closeFolio:()=>{}})`);
  return { dom, win, layout: (win as any).layout as ReturnType<typeof mountReaderLayout>, touch(value: boolean) { query.matches = value; update(); } };
}

test("browser preference overrides detection, restores controls, and survives reopening", () => {
  const { dom, win, layout, touch } = fixture();
  try {
    const controls = win.document.querySelector<HTMLElement>("#controls")!;
    expect(layout.mode()).toBe("desktop"); expect(controls.hidden).toBe(true); expect(controls.inert).toBe(true);
    touch(true);
    expect(layout.mode()).toBe("mobile"); expect(controls.querySelectorAll("#comment,#source")).toHaveLength(2);
    layout.select("desktop");
    touch(false); touch(true);
    expect(layout.mode()).toBe("desktop"); expect(controls.inert).toBe(true);
    expect(win.document.querySelectorAll("#comment")).toHaveLength(1);
    expect(win.document.querySelector("#comment")!.parentElement!.id).toBe("home");
    expect(win.localStorage.getItem("tether.readerMode")).toBe("desktop");
    layout.select("mobile"); touch(false);
    expect(layout.mode()).toBe("mobile"); expect(controls.hidden).toBe(false);
    const reopened = fixture(win.localStorage.getItem("tether.readerMode")!);
    expect(reopened.layout.mode()).toBe("mobile"); reopened.dom.window.close();
    const otherBrowser = fixture();
    expect(otherBrowser.layout.mode()).toBe("desktop"); otherBrowser.dom.window.close();
  } finally { layout.destroy(); dom.window.close(); }
});

test("another tab's preference updates the reader; clearing it restores detection", () => {
  const { dom, win, layout } = fixture("mobile");
  try {
    win.localStorage.setItem("tether.readerMode", "desktop");
    win.dispatchEvent(new win.StorageEvent("storage", { key: "tether.readerMode" }));
    expect(layout.mode()).toBe("desktop");
    win.localStorage.clear();
    win.dispatchEvent(new win.StorageEvent("storage", { key: null }));
    expect(layout.mode()).toBe("desktop");
  } finally { layout.destroy(); dom.window.close(); }
});
