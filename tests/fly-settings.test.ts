import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountFlySettings } from "../src/web/fly-settings";

function fixture(state: any, request?: (action: string) => Promise<any>, localOwner = true) {
  const dom = new JSDOM('<section id="fly"></section>', { url: "http://127.0.0.1:1234/settings", runScripts: "outside-only" });
  let offline = false;
  const calls: Array<{action:string;body:any}> = [];
  (dom.window as any).request = async (action: string, body: any) => {
    if (offline) throw new Error("offline");
    calls.push({ action, body });
    return action === "status" ? structuredClone(state) : request ? request(action) : {};
  };
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value() { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value() { this.open = false; } });
  let scheduled: (() => Promise<void>) | undefined;
  dom.window.setTimeout = ((callback: () => Promise<void>, delay: number) => { if (delay === 3000) scheduled = callback; return 1; }) as any;
  dom.window.eval(`(${mountFlySettings.toString()})(document.querySelector('#fly'),request,${localOwner})`);
  const click = (label: string) => { const button = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === label); if (!button) throw new Error(`Missing button: ${label}`); button.click(); };
  return { dom, calls, click, disconnect: () => { offline = true; }, poll: async () => { await scheduled?.(); } };
}
const state = { configured: true, enabled: true, origin: "https://hub.example", localMachineId: "local", machines: [{ id: "local", name: "Mac", qualifyPaths: false }, { id: "remote", name: "Phoenix", qualifyPaths: true }], clients: [], attempts: [] };

test("hub selection uses enrolled machines and retains the chosen identity", async () => {
  const f = fixture(state);
  try {
    await Bun.sleep(0); f.click("All my computers are connected");
    const picker = f.dom.window.document.querySelector('.hub-picker')!;
    expect(picker.querySelector('summary strong')?.textContent).toBe('Mac (this machine)');
    expect(picker.querySelector('input:checked')?.getAttribute('value')).toBe('local');
    const remote = picker.querySelector<HTMLInputElement>('input[value="remote"]')!;
    remote.checked = true; remote.dispatchEvent(new f.dom.window.Event('change'));
    f.click('Continue'); await Bun.sleep(0);
    expect(f.calls.find(call => call.action === 'attempt')?.body.answers).toMatchObject({ relocate: true, hub: 'Phoenix', machineId: 'remote', qualifyPaths: true });
  } finally { f.dom.window.close(); }
});

test("editing a relocation retains its selected destination", async () => {
  const attempt = { id: "move", phase: "awaiting agent", answers: { hub: "Phoenix", machine: "Phoenix", machineId: "remote", access: "browser", qualifyPaths: true, internet: false, relocate: true } };
  const f = fixture({ ...state, attempts: [attempt] });
  try {
    await Bun.sleep(0); f.click("Change answers");
    expect(f.dom.window.document.querySelector('.hub-picker summary')?.textContent).toBe("Phoenix");
    f.click("Continue"); await Bun.sleep(0);
    expect(f.calls.find(call => call.action === "attempt")?.body).toEqual({ id: "move", answers: attempt.answers });
  } finally { f.dom.window.close(); }
});

test("first setup uses this computer and postpones hub and machine selection", async () => {
  const f = fixture({ ...state, configured: false });
  try {
    await Bun.sleep(0); f.click('Set up Tether Fly');
    const select = f.dom.window.document.querySelector('select')!;
    expect([...select.options].map(option => option.textContent)).toEqual(['Paseo','cmux','Wave','Browser']);
    expect(f.dom.window.document.querySelector('h4')?.textContent).toBe('Where will you primarily use Tether?');
    f.click('Next'); f.click('Next'); f.click('Prepare setup'); await Bun.sleep(0);
    expect(f.calls.find(call => call.action === 'attempt')?.body.answers).toMatchObject({ initialSetup: true, hub: 'Mac', machine: 'Mac', machineId: 'local' });
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

test("polling preserves unsaved machine edits and expanded sections", async () => {
  const current = structuredClone(state), f = fixture(current);
  try {
    await Bun.sleep(0);
    const group = [...f.dom.window.document.querySelectorAll('details')].find(item => item.textContent?.startsWith('File machines'))!;
    group.open = true;
    expect(group.querySelector('form')).toBeNull();
    expect(group.querySelectorAll('tbody tr')).toHaveLength(2);
    (group.querySelector('[data-edit-machine="local"]') as HTMLButtonElement).click();
    const name = group.querySelector('input')!;
    name.value = 'Unfinished'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    current.machines[1]!.name = 'Changed remotely';
    await f.poll();
    expect(name.isConnected).toBe(true); expect(name.value).toBe('Unfinished');
    f.click('Save machine'); await Bun.sleep(0);
    expect(f.calls.find(call => call.action === 'machine')?.body.name).toBe('Unfinished');
    expect([...f.dom.window.document.querySelectorAll('details')].find(item => item.textContent?.startsWith('File machines'))!.open).toBe(true);
    expect(f.dom.window.document.querySelector('[role=status]')?.textContent).toBe('Machine saved.');
    expect(f.dom.window.document.querySelector('.machine-table')?.hasAttribute('hidden')).toBe(false);
    expect(f.dom.window.document.activeElement?.getAttribute('data-edit-machine')).toBe('local');
  } finally { f.dom.window.close(); }
});

test("verification choices still refresh after selecting a machine", async () => {
  const current: any = { ...structuredClone(state), verificationDocuments: [], attempts: [{ id:'setup', phase:'waiting', answers:{ access:'paseo', machineId:'remote' } }] };
  const f = fixture(current, undefined, false);
  try {
    await Bun.sleep(0);
    f.dom.window.document.querySelector('select[aria-label="File machine to verify"]')!.dispatchEvent(new f.dom.window.Event('change', { bubbles:true }));
    current.clients.push({id:'new-client',name:'Paseo',machineId:'remote',kind:'agent',revokedAt:null});
    current.verificationDocuments.push({id:'doc',machineId:'remote',path:'/notes.md'});
    await f.poll();
    expect(f.dom.window.document.querySelector('select[aria-label="Paseo client to verify"]')?.textContent).toBe('Paseo');
    expect(f.dom.window.document.querySelector('select[aria-label="Document to verify"]')?.textContent).toBe('/notes.md');
  } finally { f.dom.window.close(); }
});

test("machine save failures retain the editor and Cancel discards only that machine's draft", async () => {
  const current = structuredClone(state), f = fixture(current, async () => { throw new Error("Machine unavailable"); });
  try {
    await Bun.sleep(0);
    const password = f.dom.window.document.querySelector<HTMLInputElement>('input[type="password"]')!;
    password.value = 'An unfinished password'; password.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const table = f.dom.window.document.querySelector('table')!;
    (table.querySelector('[data-edit-machine="remote"]') as HTMLButtonElement).click();
    const form = f.dom.window.document.querySelector<HTMLFormElement>('form[aria-label="Edit Phoenix"]')!;
    const name = form.querySelector('input')!;
    expect(f.dom.window.document.querySelectorAll('.settings-section')).toHaveLength(1);
    name.value = 'Unsaved machine'; name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    f.click('Save machine'); await Bun.sleep(0);
    expect(form.isConnected).toBe(true); expect(table.hidden).toBe(true); expect(name.value).toBe('Unsaved machine');
    expect(f.dom.window.document.querySelector('[role=status]')?.textContent).toBe('Machine unavailable');
    f.click('Cancel');
    expect(form.isConnected).toBe(false); expect(table.hidden).toBe(false);
    expect(table.textContent).toContain('Phoenix'); expect(table.textContent).not.toContain('Unsaved machine');
    expect(f.dom.window.document.activeElement?.getAttribute('data-edit-machine')).toBe('remote');
    (f.dom.window.document.activeElement as HTMLElement).blur();
    current.machines[0]!.name = 'Changed remotely'; await f.poll();
    expect(password.isConnected).toBe(true); expect(password.value).toBe('An unfinished password');
  } finally { f.dom.window.close(); }
});

test("setup cancellation is immediate even when the hub is offline", async () => {
  const f = fixture(state);
  try {
    await Bun.sleep(0); f.click('Connect a machine or browser');
    f.disconnect();
    f.click('Cancel');
    expect(f.dom.window.document.querySelector('h3')?.textContent).toBe('Tether Fly');
    expect(f.dom.window.document.body.textContent).toContain('Connections enabled');
    await Bun.sleep(0);
    expect(f.dom.window.document.querySelector('[role=status]')?.textContent).toContain('Waiting for the hub');
  } finally { f.dom.window.close(); }
});

test("successful setup leaves the wizard even when draft storage is unavailable", async () => {
  const f = fixture(state);
  try {
    await Bun.sleep(0); f.click('Connect a machine or browser');
    const select = f.dom.window.document.querySelector('select')!;
    select.value = 'browser'; select.dispatchEvent(new f.dom.window.Event('change'));
    f.click('Next');
    f.dom.window.Storage.prototype.removeItem = () => { throw new Error('Storage disabled'); };
    f.click('Prepare setup'); await Bun.sleep(0);
    expect(f.calls.filter(call => call.action === 'attempt')).toHaveLength(1);
    expect(f.dom.window.document.querySelector('h3')?.textContent).toBe('Tether Fly');
  } finally { f.dom.window.close(); }
});
