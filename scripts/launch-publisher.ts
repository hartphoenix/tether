import { generateKeyPairSync } from 'node:crypto';
import { mkdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Run in the user's terminal. This entry point must not run inside the agent sandbox.
export async function launchPublisher(helper: string, agent: string, args: string[], inherited: NodeJS.ProcessEnv = process.env) {
  const env = {...inherited};
  for (const name of Object.keys(env)) if (name.startsWith('OP_') || name === 'TETHER_PUBLISHER_DOCUMENT') delete env[name];
  env.OP_BIOMETRIC_UNLOCK_ENABLED = 'false';
  const exists = Bun.spawn([helper,'exists'],{env,stdin:'ignore',stdout:'ignore',stderr:'inherit'});
  const status = await exists.exited;
  if (status !== 0 && status !== 3) throw new Error('Cannot inspect the publisher Keychain item.');
  if (status === 3) {
    const key = generateKeyPairSync('ed25519');
    const bytes = Buffer.from(JSON.stringify({format:1,purpose:'tether-publisher',privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}).toString()}));
    try {
      const child = Bun.spawn([helper,'create'],{env,stdin:new Blob([bytes]),stdout:'inherit',stderr:'inherit'});
      if (await child.exited !== 0) throw new Error('Keychain creation failed; inspect the item before retrying.');
    } finally { bytes.fill(0); }
  }
  const child = Bun.spawn([helper,'launch','--',agent,...args],{env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});
  return await child.exited;
}
async function buildHelper(root: string) {
  const source=join(root,'scripts/releases/native/publisher-keychain.m'),directory=join(root,'.local/bin'),helper=join(directory,'publisher-keychain');
  await mkdir(directory,{recursive:true,mode:0o700});
  const built=await stat(helper).catch(()=>undefined);
  if(built && built.mtimeMs >= (await stat(source)).mtimeMs) return helper;
  const candidate=helper+'.'+crypto.randomUUID();
  for(const args of [
    ['/usr/bin/clang','-fobjc-arc','-framework','Foundation','-framework','Security','-Wno-deprecated-declarations',source,'-o',candidate],
    ['/usr/bin/codesign','--sign','-',candidate],
  ]) {
    const child=Bun.spawn(args,{stdout:'inherit',stderr:'inherit'});
    if(await child.exited!==0) throw new Error('Cannot build publisher Keychain helper.');
  }
  await rename(candidate,helper);return helper;
}
if(import.meta.main) {
  try {
    const root=resolve(import.meta.dir,'..');
    const env: NodeJS.ProcessEnv={...process.env,HART_CODEX_REVIEWER_MODE:'auto_review'};
    if(!env.GH_TOKEN) {
      const child=Bun.spawn(['gh','auth','token'],{stdout:'pipe',stderr:'ignore'});
      const token=(await new Response(child.stdout).text()).trim();
      if(await child.exited!==0 || !token) throw new Error('GitHub authentication unavailable; run gh auth status in your terminal.');
      env.GH_TOKEN=token;
    }
    const wrapper='/Applications/cmux.app/Contents/Resources/bin/cmux-codex-wrapper';
    const agent=process.env.CMUX_SURFACE_ID && await Bun.file(wrapper).exists()?wrapper:'/opt/homebrew/bin/codex';
    const args=process.argv.slice(2);
    process.chdir(root);
    process.exitCode=await launchPublisher(await buildHelper(root),agent,['-C',root,'-c','approvals_reviewer="auto_review"',...(args.length?args:['resume'])],env);
  } catch(error) {
    // Only our fixed error messages are rendered; no process environment or item data.
    console.error(error instanceof Error && error.message.startsWith('GitHub authentication')?error.message:'Publisher launcher failed; check Keychain approval and local build tools.');
    process.exitCode=1;
  }
}
