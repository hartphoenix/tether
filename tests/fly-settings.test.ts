import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountFlySettings } from "../src/web/fly-settings";

function fixture(state: any, request?: (action: string) => Promise<any>) {
  const dom = new JSDOM('<section id="fly"></section>', { url: "http://127.0.0.1:1234/settings", runScripts: "outside-only" });
  const calls: Array<{action:string;body:any}> = [];
  (dom.window as any).request = async (action: string, body: any) => {
    calls.push({ action, body });
    return action === "status" ? state : request ? request(action) : {};
  };
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value() { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value() { this.open = false; } });
  dom.window.eval(`(${mountFlySettings.toString()})(document.querySelector('#fly'),request,true)`);
  const click = (label: string) => { const button = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === label); if (!button) throw new Error(`Missing button: ${label}`); button.click(); };
  return { dom, calls, click };
}
const state = { configured: true, enabled: true, origin: "https://hub.example", localMachineId: "local", machines: [{ id: "local", name: "Mac", qualifyPaths: false }, { id: "remote", name: "Phoenix", qualifyPaths: true }], clients: [], attempts: [] };

test("setup keeps relocation intent and existing machine copy preference through Back", async () => {
  const f = fixture(state);
  try {
    await Bun.sleep(0); f.click("Disable Tether Fly…"); f.click("Disable this machine and relocate Tether to a different one");
    const hub = f.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Which computer should be Tether’s hub?"]')!;
    expect(hub.value).toBe(""); hub.value = "New hub"; hub.dispatchEvent(new f.dom.window.Event("input"));
    f.click("Next"); f.click("Next");
    const machine = f.dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="File machine"]')!;
    machine.value = "remote"; machine.dispatchEvent(new f.dom.window.Event("change"));
    f.click("Next");
    expect(f.dom.window.document.querySelector('select')!.value).toBe("true");
    f.click("Back"); expect(f.dom.window.document.querySelector('select')!.value).toBe("remote");
    f.click("Next"); f.click("Next"); f.click("Prepare setup"); await Bun.sleep(0);
    expect(f.calls.find(call => call.action === "attempt")?.body.answers).toMatchObject({ relocate: true, hub: "New hub", machineId: "remote", qualifyPaths: true });
  } finally { f.dom.window.close(); }
});

test("owner enrollment reserves its popup in the click before awaiting authorization", async () => {
  let release!: (value: any) => void;
  const f = fixture(state, async () => new Promise(resolve => { release = resolve; }));
  const child = { location: { href: "about:blank" }, close() {}, postMessage() {} };
  let opened = false;
  (f.dom.window as any).open = () => { opened = true; return child; };
  try {
    await Bun.sleep(0); f.click("Set up or recover owner passkey"); expect(opened).toBe(true);
    expect(child.location.href).toBe("about:blank");
    release({ verificationUrl: "https://hub.example/auth/enroll", code: "fixture" }); await Bun.sleep(0);
    expect(child.location.href).toBe("https://hub.example/auth/enroll");
  } finally { f.dom.window.close(); }
});
