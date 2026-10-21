import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativePasteScript } from '../integrations/paseo/client/native-paste';
import { pasteTextInput } from '../src/web/text-paste';

// Playwright's Electron debugger transport needs Node; Bun 1.3.9 rejects its
// WebSocket upgrade. Keep the public entrypoint consistent with other checks.
if (typeof Bun !== 'undefined') {
  const scratch = resolve(import.meta.dir, '../.local');
  await mkdir(scratch, { recursive: true });
  const buildDirectory = await mkdtemp(join(scratch, 'native-paste-check-'));
  let code = 1;
  try {
    const result = await Bun.build({ entrypoints: [import.meta.path], target: 'node', packages: 'external' });
    if (!result.success) throw new Error(String(result.logs));
    const output = join(buildDirectory, 'check.mjs');
    await writeFile(output, await result.outputs[0].text());
    code = await Bun.spawn(['node', output, ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' }).exited;
  } finally { await rm(buildDirectory, { recursive: true, force: true }); }
  process.exit(code);
}

// Supply a matching Electron executable. This uses the existing clipboard without
// reading it into the driver, changing it, or logging its contents.
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Usage: bun scripts/check-paseo-native-paste.ts /path/to/Electron');
const directory = await mkdtemp(join(tmpdir(), 'tether-native-paste-'));
const main = join(directory, 'main.cjs');
await writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{webviewTag:true,nodeIntegration:true,contextIsolation:false}});
  global.testWindow=win;
  const attached=new Promise(resolve=>win.webContents.once('did-attach-webview',(_,guest)=>resolve(guest)));
  await win.loadURL('data:text/html,'+encodeURIComponent('<webview src="data:text/html,<textarea autofocus></textarea><input readonly><div contenteditable></div>" style="width:600px;height:300px"></webview>'));
  global.testGuest=await attached;
  if(global.testGuest.isLoading())await new Promise(resolve=>global.testGuest.once('did-stop-loading',resolve));
  global.testReady=true;
}).catch(error=>{global.testError=error.message});`);
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  application = await electron.launch({ executablePath: resolve(executablePath), args: [main] });
  const app = application;
  await app.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (!(globalThis as any).testReady) {
      if ((globalThis as any).testError) throw new Error((globalThis as any).testError);
      if (Date.now() > deadline) throw new Error('Guest startup timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  const setup = `(() => {
    window.pasteCount=0; window.block=false; window.policy=false;
    window.addEventListener('keydown', event => {
      if(window.policy) window.addEventListener('keydown', next => {
        if(next===event) next.preventDefault();
      }, {once:true});
    }, true);
    document.addEventListener('keydown', event => { if(window.block) event.preventDefault(); });
    document.addEventListener('keydown', () => { const until=performance.now()+30; while(performance.now()<until) {} });
    document.addEventListener('paste', () => window.pasteCount++);
    document.addEventListener('paste', ${pasteTextInput.toString()});
    document.querySelector('textarea').focus();
  })(); ${nativePasteScript('test-native-paste:')}`;
  await app.evaluate(async ({}, script) => {
    const guest = (globalThis as any).testGuest;
    // A permanently closed gate deterministically exercises the problematic route.
    guest.setIgnoreMenuShortcuts(true);
    await (globalThis as any).testWindow.webContents.executeJavaScript(`
      window.nativeRequests=0;
      const view=document.querySelector('webview');
      view.focus();
      view.addEventListener('console-message', event => {
        if(event.message.startsWith('test-native-paste:')) { window.nativeRequests++; view.paste(); }
      });`);
    await guest.executeJavaScript(script);
  }, setup);
  const evaluate = (script: string) => app.evaluate(async ({}, code) => (globalThis as any).testGuest.executeJavaScript(code), script);
  const key = async (modifiers = ['meta'], targetKey = 'v') => {
    await app.evaluate(async ({}, { modifiers, targetKey }) => {
      const guest = (globalThis as any).testGuest;
      guest.sendInputEvent({type:'keyDown',keyCode:targetKey,modifiers});
      guest.sendInputEvent({type:'keyUp',keyCode:targetKey,modifiers});
      guest.sendInputEvent({type:'keyUp',keyCode:'Meta',modifiers:[]});
      await new Promise(resolve=>setTimeout(resolve,100));
    }, { modifiers, targetKey });
  };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  await key();
  check(await evaluate('window.pasteCount') === 1, 'Native bridge did not deliver exactly one paste');
  check(await evaluate('document.querySelector("textarea").value.length > 0'), 'Copy nonempty text before running this check');
  await evaluate('window.firstValue=document.querySelector("textarea").value');
  for (let index = 0; index < 4; index++) await key();
  check(await evaluate('window.pasteCount===5 && document.querySelector("textarea").value===window.firstValue.repeat(5)'), 'Repeated native paste lost or duplicated text');
  for (let count = 4; count >= 0; count--) {
    await app.evaluate(() => (globalThis as any).testGuest.undo());
    check(await evaluate(`document.querySelector('textarea').value===window.firstValue.repeat(${count})`), 'Undo merged paste transactions');
  }
  for (let count = 1; count <= 5; count++) {
    await app.evaluate(() => (globalThis as any).testGuest.redo());
    check(await evaluate(`document.querySelector('textarea').value===window.firstValue.repeat(${count})`), 'Redo lost a paste transaction');
  }
  await evaluate('document.querySelector("textarea").select()');
  await key();
  check(await evaluate('document.querySelector("textarea").value===window.firstValue'), 'Selection replacement failed');
  await evaluate('window.block=true'); await key();
  await evaluate('window.block=false; window.policy=true'); await key();
  await evaluate('window.policy=false');
  await key(['meta','shift']); await key(['meta'], 'r');
  await evaluate('document.querySelector("input").focus()'); await key();
  await evaluate('document.querySelector("div").focus()'); await key();
  check(await evaluate('window.pasteCount') === 6, 'Workaround intercepted a cancelled, policy-owned, read-only, editor or other shortcut');
  await evaluate('document.querySelector("textarea").focus(); document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", {key:"v",metaKey:true,bubbles:true,cancelable:true}))');
  check(await evaluate('window.pasteCount') === 6, 'Untrusted key requested native paste');
  console.log('Native paste passed: closed menu gate, 30 ms renderer delay, six insertions, separate Undo/Redo, replacement, page/policy cancellation and excluded targets.');
  console.log(await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, name: app.getName() })));
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}
