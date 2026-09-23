import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchPublisher } from '../scripts/launch-publisher';

test('parent launcher creates through stdin, removes old credentials, and forwards agent arguments', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tether-launcher-'));
  try {
    const helper=join(directory,'helper'),agent=join(directory,'agent');
    await writeFile(helper,`#!${process.execPath}
      const args=process.argv.slice(2);
      if(process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.OP_SESSION_TEST || process.env.OP_CONNECT_TOKEN || process.env.TETHER_PUBLISHER_DOCUMENT) process.exit(9);
      if(args[0]==='exists') process.exit(3);
      if(args[0]==='create') {
        const d=await Bun.stdin.json();
        if(args.length!==1 || d.purpose!=='tether-publisher' || !d.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) process.exit(8);
      } else if(args[0]==='launch') {
        if(args[1]!=='--') process.exit(7);
        const child=Bun.spawn(args.slice(2),{env:{...process.env,TETHER_PUBLISHER_DOCUMENT:'fixture'},stdout:'ignore',stderr:'ignore'});
        process.exit(await child.exited);
      }`,{mode:0o700});
    await writeFile(agent,`#!${process.execPath}
      if(process.env.TETHER_PUBLISHER_DOCUMENT!=='fixture' || process.env.GH_TOKEN!=='fixture-github' || process.env.OP_BIOMETRIC_UNLOCK_ENABLED!=='false') process.exit(6);
      if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['resume','fixture-id'])) process.exit(5);`,{mode:0o700});
    const env={PATH:process.env.PATH,GH_TOKEN:'fixture-github',OP_SERVICE_ACCOUNT_TOKEN:'old',OP_SESSION_TEST:'old',OP_CONNECT_TOKEN:'old',TETHER_PUBLISHER_DOCUMENT:'old'};
    expect(await launchPublisher(helper,agent,['resume','fixture-id'],env)).toBe(0);
    expect(env.TETHER_PUBLISHER_DOCUMENT).toBe('old');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('launcher stops when Keychain inspection fails and preserves an existing item', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tether-launcher-'));
  try {
    const helper=join(directory,'helper');
    await writeFile(helper,`#!${process.execPath}\nprocess.exit(1);`,{mode:0o700});
    await expect(launchPublisher(helper,'/does-not-exist',[],{})).rejects.toThrow('Cannot inspect');
    await writeFile(helper,`#!${process.execPath}\nconst c=process.argv[2];process.exit(c==='exists'?0:c==='launch'?42:99);`);
    expect(await launchPublisher(helper,'/does-not-exist',[],{})).toBe(42);
  }finally{await rm(directory,{recursive:true,force:true});}
});
