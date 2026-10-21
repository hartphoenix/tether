/** Phone/mobile verification is suspended by the project instructions in AGENTS.md. */
import { resolve, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";

const cwd = resolve(import.meta.dir, "..");
const files = [...new Bun.Glob("tests/**/*.test.ts").scanSync({ cwd })]
  .filter(path => !/phone|mobile/i.test(path)).sort();
const namePattern = "^(?!.*[Pp][Hh][Oo][Nn][Ee])(?!.*[Mm][Oo][Bb][Ii][Ll][Ee])";
if (Bun.argv.includes("--list")) {
  console.log(JSON.stringify({ files, namePattern }, null, 2));
} else {
  const directory = await mkdtemp(join(tmpdir(), "tether-tests-"));
  console.log(`Testing ${files.length} files in fresh sequential processes. Logs: ${directory}`);
  const results: object[] = [];
  for (const [index, file] of files.entries()) {
    console.log(`[${index + 1}/${files.length}] ${file}`);
    const started = Date.now();
    const log = Bun.file(join(directory, `${index + 1}-${file.split('/').pop()}.log`)).writer();
    const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", namePattern, file], {
      cwd, stdin: "inherit", stdout: "pipe", stderr: "pipe",
    });
    const descendants = new Set<number>();
    let peakRssKiB: number | null = null;
    const sample = async () => {
      const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss="], { stdout: "pipe", stderr: "ignore" });
      const rows = (await new Response(ps.stdout).text()).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      await ps.exited;
      const owned = new Set([child.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of rows) if (owned.has(parent!) && !owned.has(pid!)) { owned.add(pid!); descendants.add(pid!); changed = true; }
      }
      if (rows.some(([pid]) => pid === child.pid)) peakRssKiB = Math.max(peakRssKiB ?? 0, rows.reduce((sum, [pid, , rss]) => sum + (owned.has(pid!) ? rss! : 0), 0));
      return rows.filter(([pid]) => descendants.has(pid!)).map(([pid]) => pid);
    };
    let sampling = Promise.resolve<number[] | undefined>(undefined);
    const timer = setInterval(() => { sampling = sampling.then(() => sample()).catch(() => undefined); }, 1000);
    const copy = async (stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream) => {
      for await (const chunk of stream) { log.write(chunk); if (!destination.write(chunk)) await once(destination, 'drain'); }
    };
    const output = Promise.all([copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)]);
    const code = await child.exited;
    clearInterval(timer);
    await Promise.all([output, sampling]);
    await log.end();
    const remainingChildren = await sample().catch(() => []);
    results.push({ file, exitCode: code, signal: child.signalCode, elapsedMs: Date.now() - started, peakSampledTreeRssKiB: peakRssKiB, remainingChildren });
    await Bun.write(join(directory, "results.json"), JSON.stringify({ discovered: files.length, completed: results.length, results }, null, 2));
    if (remainingChildren.length) console.error(`Observed surviving child PIDs: ${remainingChildren.join(', ')} (recorded; not terminated automatically)`);
    if (code !== 0) { console.error(`Failed: ${file}. Diagnostics: ${directory}`); process.exit(code); }
  }
  console.log(`Passed all ${files.length} test files. Diagnostics: ${directory}`);
}
