import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
// Fault mocks run in separate processes so built-in module replacements cannot
// affect another test or the user's real host/installation.
async function isolated(script: string): Promise<any> {
  const prelude = `
    import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    import { join } from "node:path";
    const root = await fs.mkdtemp("/tmp/tether-failure-boundary-");
    const modulePath = path => ${JSON.stringify(repository)} + "/" + path;
    try { ${script} } finally { await fs.rm(root, {recursive:true, force:true}); }
  `;
  const child = Bun.spawn([process.execPath, "-e", prelude], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}

test("export reports the published file when directory durability confirmation fails", async () => {
  const result = await isolated(`
    const realOpen = fs.open;
    mock.module("node:fs/promises", () => ({...fs, open: async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      if (path !== root || flags !== "r") return handle;
      return new Proxy(handle, {get(target, key) {
        if (key === "sync") return async () => { throw Object.assign(new Error("sync failed"), {code:"EIO", syscall:"fsync"}); };
        const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
      }});
    }}));
    const {writeExport} = await import(modulePath("src/cli/io.ts"));
    const output = join(root,"export.tether");
    let failure; try {await writeExport(output,"payload");} catch(error) {failure={code:error.code, details:error.details};}
    console.log(JSON.stringify({failure, body:await fs.readFile(output,"utf8")}));
  `);
  expect(result.body).toBe("payload");
  expect(result.failure).toMatchObject({ code: "EIO", details: { outcome: "applied", durability: "unconfirmed", diagnostic: { code: "EIO", syscall: "fsync" } } });
});

test("uninstall reports the first removed launcher if removing the second fails", async () => {
  const result = await isolated(`
    const release = join(root,"releases","v1"), bin=join(root,"bin");
    await fs.mkdir(release,{recursive:true}); await fs.mkdir(bin);
    await fs.symlink(release,join(root,"current"));
    await fs.writeFile(join(root,"install.json"),JSON.stringify({binDirectory:bin}));
    for(const name of ["tether","mdreview"]) {await fs.writeFile(join(release,name),"fixture");await fs.symlink(join(root,"current",name),join(bin,name));}
    process.env.TETHER_INSTALL_ROOT=release;
    const realUnlink=fs.unlink;
    mock.module("node:fs/promises",()=>({...fs,unlink:async path=>{if(path===join(bin,"mdreview")) throw Object.assign(new Error("unlink denied"),{code:"EACCES",path,syscall:"unlink"});return realUnlink(path);}}));
    mock.module(modulePath("src/hosts/wave-launchers.ts"),()=>({syncWaveRecentLaunchers:async()=>{},waveLauncherStatus:async()=>({installed:[]}),installWaveLaunchers:async()=>{},uninstallWaveLaunchers:async()=>{throw new Error("Must not touch Wave");}}));
    const {runCli}=await import(modulePath("src/cli/main.ts"));
    const {resolveConfig}=await import(modulePath("src/server/config.ts"));
    const config=resolveConfig({runtimeDir:join(root,"runtime"),configDir:join(root,"config")});
    const result=await runCli(["uninstall","--confirm"],{config});
    console.log(JSON.stringify({result,firstExists:await fs.lstat(join(bin,"tether")).then(()=>true,()=>false),secondExists:await fs.lstat(join(bin,"mdreview")).then(()=>true,()=>false)}));
  `);
  expect(result.firstExists).toBe(false);
  expect(result.secondExists).toBe(true);
  expect(result.result).toMatchObject({ exitCode: 1, response: { command: "uninstall", error: { code: "EACCES", details: { outcome: "partially_applied", completed: [{ step: "command_removed" }] } } } });
});

test("failed updater preserves its backup, exit code, and safe bounded subprocess evidence", async () => {
  const result = await isolated(`
    const release=join(root,"releases","v1"),configDir=join(root,"config");
    await fs.mkdir(release,{recursive:true});await fs.mkdir(configDir);
    await fs.writeFile(join(root,"install.json"),JSON.stringify({binDirectory:join(root,"bin")}));
    await fs.writeFile(join(release,"install.sh"),'echo install-attempt; echo WAVETERM_JWT=fixture-credential >&2; exit 7');
    process.env.TETHER_INSTALL_ROOT=release;
    const {PrivateStore}=await import(modulePath("src/storage/private-store.ts"));
    const store=new PrivateStore(join(configDir,"tether.sqlite"));store.close();
    const {runCli}=await import(modulePath("src/cli/main.ts"));
    const {resolveConfig}=await import(modulePath("src/server/config.ts"));
    const result=await runCli(["update"],{config:resolveConfig({configDir,runtimeDir:join(root,"runtime")})});
    const backup=result.response.error.details.completed[0].path;
    console.log(JSON.stringify({result,backupExists:await fs.stat(join(backup,"manifest.json")).then(()=>true,()=>false)}));
  `);
  expect(result.backupExists).toBe(true);
  expect(result.result).toMatchObject({ exitCode: 1, response: { command: "update", error: { code: "update_failed", details: { outcome: "outcome_unknown", diagnostic: { exitCode: 7 }, completed: [{ step: "backup_created" }] } } } });
  expect(JSON.stringify(result)).not.toContain("fixture-credential");
});

test("a storage error during registration validation remains definitely not applied", async () => {
  const result = await isolated(`
    const path=join(root,"storage.md"),realStat=fs.stat;
    mock.module("node:fs/promises",()=>({...fs,stat:async value=>{if(value===path)throw Object.assign(new Error("read failed"),{code:"EIO",syscall:"stat",path});return realStat(value);}}));
    const {resolveConfig}=await import(modulePath("src/server/config.ts"));
    const {createDaemon}=await import(modulePath("src/server/server.ts"));
    const {runCli}=await import(modulePath("src/cli/main.ts"));
    const config=resolveConfig({runtimeDir:join(root,"runtime"),configDir:join(root,"config")});
    const daemon=createDaemon({config,startupGraceMs:600000,web:()=>new Response("test")});
    try {await daemon.ready;console.log(JSON.stringify(await runCli(["recents","add",path],{config})));}
    finally {await daemon.stop();}
  `);
  expect(result.response).toMatchObject({ error: { code: "storage_unavailable", details: { outcome: "not_applied", diagnostic: { code: "EIO", syscall: "stat" } } } });
});

test("fallible startup maintenance finishes before discovery is published", async () => {
  const result = await isolated(`
    const {RecentsService}=await import(modulePath("src/recents/service.ts"));
    const {createDaemon}=await import(modulePath("src/server/server.ts"));
    const {resolveConfig}=await import(modulePath("src/server/config.ts"));
    const config=resolveConfig({runtimeDir:join(root,"runtime"),configDir:join(root,"config")});
    let release,entered;
    const waiting=new Promise(resolve=>{entered=resolve});
    const blocked=new Promise(resolve=>{release=resolve});
    RecentsService.prototype.expire=async()=>{entered();await blocked;throw Object.assign(new Error("startup storage failure"),{code:"EIO"});};
    const daemon=createDaemon({config,web:()=>new Response("test")});
    const rejected=daemon.ready.then(()=>null,error=>error.code);
    await waiting;
    const published=await fs.stat(config.discoveryPath).then(()=>true,()=>false);
    release();const code=await rejected;await daemon.closed;
    console.log(JSON.stringify({published,code}));
  `);
  expect(result).toEqual({ published: false, code: "EIO" });
});
