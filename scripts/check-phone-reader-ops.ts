/** Opt-in native launchd regression; never targets the installed pilot label, ports or state. */
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const repository = resolve(import.meta.dir, "..");
if (process.platform !== "darwin") throw new Error("This check requires macOS launchd.");
await mkdir(join(repository, ".local"), { recursive: true });
const temporary = await mkdtemp(join(repository, ".local/phone-restart-test-"));
const label = `net.tether.phone-reader-test-${process.pid}`;
const service = `gui/${process.getuid!()}/${label}`;
const installed = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
// Reserve distinct OS-selected ports until fixture configuration is ready.
const reservations = [Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })];
const ports = reservations.map(server => server.port!);
if (ports.some(port => [8413, 8414].includes(port))) throw new Error("Refusing a pilot port.");
const rewritePorts = (source: string) => source.replace(/\b841[34]\b/g, port => String(ports[port === "8413" ? 0 : 1]));
async function run(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code && !allowFailure) throw new Error(`${args[1]} failed (${code}): ${out}${err}`);
  return { code, out, err };
}
const ctl = (command: string, ...args: string[]) => run([process.execPath, join(temporary, "scripts/phone-reader-ctl.ts"), command, ...args]);
try {
  const hash = (await run(["git", "rev-parse", "HEAD"])).out.trim();
  const root = join(temporary, ".local/phone-reader-ops");
  const release = join(root, "releases", hash);
  await mkdir(join(temporary, "scripts"), { recursive: true });
  const controller = rewritePorts((await readFile(join(repository, "scripts/phone-reader-ctl.ts"), "utf8"))
    .replace('const label = "net.tether.phone-reader";', `const label = "${label}";`));
  if (!controller.includes(`const label = "${label}";`) || controller.includes('"net.tether.phone-reader"')) throw new Error("Fixture label isolation failed.");
  await writeFile(join(temporary, "scripts/phone-reader-ctl.ts"), controller);
  await mkdir(join(release, "scripts"), { recursive: true });
  await run(["/bin/cp", "-R", join(repository, "src"), join(release, "src")]);
  await symlink(join(repository, "node_modules"), join(release, "node_modules"));
  await writeFile(join(release, "package.json"), await readFile(join(repository, "package.json")));
  await writeFile(join(release, "scripts/phone-reader.ts"), rewritePorts(await readFile(join(repository, "scripts/phone-reader.ts"), "utf8")));
  await writeFile(join(release, "src/remote/operations-health.ts"), rewritePorts(await readFile(join(repository, "src/remote/operations-health.ts"), "utf8")));
  // This fixture tests current source, not the committed-snapshot preparation pipeline.
  await writeFile(join(release, ".phone-reader-revision"), hash);
  await writeFile(join(release, ".checked"), hash);
  const document = join(temporary, "fixture.md");
  await writeFile(document, "# Restart fixture\n\nDisposable document.\n");
  await ctl("configure", "--document", document, "--owner", "test@example.invalid", "--reader-origin", "https://reader.example.invalid",
    "--approval-origin", "https://approval.example.invalid", "--state-dir", join(temporary, "state"));
  for (const server of reservations) await server.stop(true);
  await ctl("install", hash);
  console.log(`Installed isolated ${label} on ${ports.join(", ")}`);
  const pid = async () => {
    const result = await run(["launchctl", "print", service]);
    const match = /^\s*pid = (\d+)$/m.exec(result.out);
    if (!match) throw new Error("Test service has no running process.");
    return match[1];
  };
  let previousPid = await pid();
  for (let index = 0; index < 3; index++) {
    await ctl("restart");
    await ctl("status");
    const nextPid = await pid();
    if (nextPid === previousPid) throw new Error("Restart reused the old process.");
    previousPid = nextPid;
    console.log(`Restart ${index + 1} healthy, new PID ${previousPid}`);
  }
  const nextHash = (await run(["git", "rev-parse", "HEAD~1"])).out.trim();
  const nextRelease = join(root, "releases", nextHash);
  await run(["/bin/cp", "-R", release, nextRelease]);
  await writeFile(join(nextRelease, ".phone-reader-revision"), nextHash);
  await writeFile(join(nextRelease, ".checked"), nextHash);
  await ctl("deploy", nextHash);
  const status = JSON.parse((await ctl("status")).out);
  if (status.reader?.revision !== nextHash || status.approval?.revision !== nextHash) throw new Error("Deploy did not select the fixture revision.");
  console.log("Isolated deployment healthy on both ports");
} catch (error) {
  const result = await run(["launchctl", "print", service], true);
  console.error(`Isolated launchd job present after failure: ${result.code === 0}`);
  if (result.code === 0) console.error(result.out.split("\n").filter(line => /^\s*(state|pid|runs|last exit code) =/.test(line)).join("\n"));
  throw error;
} finally {
  for (const server of reservations) await server.stop(true);
  await run(["launchctl", "bootout", service], true);
  // launchd removal is asynchronous; do not delete files while its process is exiting.
  let removed = false;
  for (let index = 0; index < 200; index++) {
    if ((await run(["launchctl", "print", service], true)).code !== 0) { removed = true; break; }
    await Bun.sleep(200);
  }
  await unlink(installed).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (removed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Cleanup still pending for isolated service ${service}; fixture retained at ${temporary}`);
}
