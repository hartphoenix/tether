import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onePassword } from '../scripts/releases/vault';
import { run } from '../scripts/release-publisher';

test('1Password adapter sends document content through stdin and reads bounded stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tether-vault-test-'));
  try {
    const executable = join(directory, 'op-fixture');
    // Disposable text only. This process asserts argv shape before returning a receipt.
    await writeFile(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);
      if(args[1]==='create') {
        const expected=['document','create','-','--vault','test','--title','title','--file-name','tether-publisher.json','--format','json'];
        if(JSON.stringify(args)!==JSON.stringify(expected) || await Bun.stdin.text()!=='fixture payload') process.exit(2);
        console.log(JSON.stringify({id:'a'.repeat(26)}));
      } else {
        if(JSON.stringify(args)!==JSON.stringify(['document','get','a'.repeat(26),'--vault','test'])) process.exit(3);
        process.stdout.write('fixture payload');
      }`, {mode:0o700});
    const vault = onePassword(executable), bytes = new TextEncoder().encode('fixture payload');
    expect(await vault.create('test','title',bytes)).toBe('a'.repeat(26));
    expect(new TextDecoder().decode(await vault.read('test','a'.repeat(26)))).toBe('fixture payload');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('1Password failures never quote output and oversized responses are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tether-vault-test-'));
  try {
    for (const [name, script, message] of [
      ['failed',"console.error('fixture private output');process.exit(1)",'1Password operation failed'],
      ['receipt',"console.log('fixture private output')",'creation receipt is missing'],
      ['large',"process.stdout.write('x'.repeat(40000))",'response size'],
    ]) {
      const executable=join(directory,name!);await writeFile(executable,`#!${process.execPath}\n${script}`,{mode:0o700});
      await expect(onePassword(executable).create('test','title',new Uint8Array())).rejects.toThrow(message!);
    }
    await expect(onePassword(join(directory,'absent')).read('test','id')).rejects.toThrow('could not start');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('publisher CLI refuses incomplete or ambiguous approval arguments', async () => {
  for (const args of [[],['--help']]) expect(await run(args)).toHaveProperty('help');
  for (const args of [['publish'],['approve','--archive','file'],['refresh','--directory','one','--directory','two'],['init','--unexpected','value']]) await expect(run(args)).rejects.toThrow();
});
