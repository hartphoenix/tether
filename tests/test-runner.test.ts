import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('desktop runner discovers files once, excludes suspended suites and propagates a failed file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tether-runner-fixture-'));
  let diagnostics: string | undefined;
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'tests'));
    const runner = join(root, 'scripts/test-desktop.ts');
    await Bun.write(runner, Bun.file(new URL('../scripts/test-desktop.ts', import.meta.url)));
    await Bun.write(join(root, 'tests/a.test.ts'), "import { test } from 'bun:test'; test('passes', () => {});");
    await Bun.write(join(root, 'tests/b.test.ts'), "import { test } from 'bun:test'; test('fails deliberately', () => { throw Error('fixture failure'); });");
    await Bun.write(join(root, 'tests/c.test.ts'), "await Bun.write('should-not-run', 'ran');");
    await Bun.write(join(root, 'tests/phone.test.ts'), "throw Error('suspended file ran');");
    const listing = Bun.spawn([process.execPath, runner, '--list'], { stdout: 'pipe', stderr: 'pipe' });
    const manifest = await new Response(listing.stdout).json() as { files: string[] };
    expect(await listing.exited).toBe(0);
    expect(manifest.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('fixture failure');
    diagnostics = stdout.match(/Logs: (.+)/)?.[1];
    expect(diagnostics).toBeDefined();
    const results = JSON.parse(await readFile(join(diagnostics!, 'results.json'), 'utf8'));
    expect(results.discovered).toBe(3);
    expect(results.completed).toBe(2);
    expect(results.results.map((row: any) => row.file)).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(results.results[1].exitCode).not.toBe(0);
    expect(await Bun.file(join(root, 'should-not-run')).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); if (diagnostics) await rm(diagnostics, { recursive: true, force: true }); }
}, 15000);
