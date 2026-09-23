import { test, expect } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
test('source launchers and a cold daemon ignore caller env files but keep explicit settings', async () => {
  const directory = await mkdtemp('/tmp/tether-cli-environment-');
  const env = { PATH: process.env.PATH!, TMPDIR: '/tmp', TETHER_CONFIG_DIR: join(directory, 'config'), TETHER_RUNTIME_DIR: join(directory, 'runtime'), TETHER_SUPPRESS_BROWSER: '1' };
  const dotenv = join(directory, '.env');
  const run = async (launcher: string, ...args: string[]) => {
    const child = Bun.spawn([join(repository, launcher), ...args], { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    // A readable file must not silently redirect the profile.
    await writeFile(dotenv, 'TETHER_PROFILE=invalid/profile\n');
    expect((await run('tether', 'daemon', 'status')).data.running).toBe(false);
    // An inaccessible file must not terminate Bun before CLI diagnostics or daemon startup.
    await chmod(dotenv, 0o000);
    expect((await run('mdreview', 'daemon', 'status')).data.running).toBe(false);
    const path = join(directory, 'document.md'); await writeFile(path, '# Test\n');
    expect((await run('mdreview', 'recents', 'add', path)).ok).toBe(true);
    expect((await run('tether', 'daemon', 'status')).data.running).toBe(true);
    expect((await run('mdreview', 'folio', 'list')).data.files.some((file: any) => file.path.endsWith('/document.md'))).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('# Test\n');
  } finally {
    await run('mdreview', 'daemon', 'stop').catch(() => {});
    await chmod(dotenv, 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
