import { chmod, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { version } from "../package.json";

if (process.platform !== "darwin") throw new Error("Release builds currently support macOS only.");
const destination = resolve(process.argv[2] ?? `dist/release/tether-${version}-darwin-${process.arch}`);
// Exclusive directory: never overwrite a previous candidate or its evidence.
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
await mkdir(join(destination, "runtime"));
await copyFile(process.execPath, join(destination, "runtime/bun"));
await chmod(join(destination, "runtime/bun"), 0o755);
const entries = {
  cli: "src/cli/main.ts", public: "src/cli/public.ts", daemon: "src/server/daemon.ts",
  "wave-bridge": "src/hosts/wave-bridge-daemon.ts", "cmux-bridge": "src/hosts/cmux-bridge-daemon.ts",
};
for (const [name, entry] of Object.entries(entries)) {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", outdir: join(destination, "lib"), naming: `${name}.js` });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
const web = await Bun.build({ entrypoints: ["src/web/index.html"], target: "browser", minify: true, outdir: join(destination, "dist") });
if (!web.success) throw new Error(web.logs.map(String).join("\n"));
await copyFile("src/web/favicon.png", join(destination, "dist/favicon.png"));
await mkdir(join(destination, "docs"));
await copyFile("docs/getting-started.md", join(destination, "docs/getting-started.md"));
await cp("integrations", join(destination, "integrations"), { recursive: true });
await copyFile("LICENSE", join(destination, "LICENSE"));
await mkdir(join(destination, "licenses"));
await copyFile("licenses/phosphor-icons-LICENSE.txt", join(destination, "licenses/phosphor-icons-LICENSE.txt"));
await copyFile(`licenses/bun-${Bun.version}-LICENSE.md`, join(destination, "licenses/Bun-LICENSE.md"));
for await (const path of new Bun.Glob("**/{LICENSE,LICENSE.md,LICENSE.txt,license,license.md,OFL.txt}").scan({ cwd: "node_modules", followSymlinks: true })) {
  const target = join(destination, "licenses", path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join("node_modules", path), target);
}
for await (const path of new Bun.Glob("**/{*OFL.txt,LICENSE*}").scan({ cwd: "src/web" })) {
  const target = join(destination, "licenses/fonts", path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join("src/web", path), target);
}
await copyFile("scripts/install.sh", join(destination, "install.sh"));
for (const [name, entry] of [["tether", "public"], ["mdreview", "cli"], ["Open Tether.command", "public"]]) {
  const launcher = `#!/bin/zsh\nset -euo pipefail\nexport TETHER_INSTALL_ROOT="\${0:A:h}"\nexec "$TETHER_INSTALL_ROOT/runtime/bun" "$TETHER_INSTALL_ROOT/lib/${entry}.js" "$@"\n`;
  await writeFile(join(destination, name!), launcher, { mode: 0o755 });
}
await writeFile(join(destination, "release.json"), JSON.stringify({ version, platform: process.platform, architecture: process.arch, runtime: Bun.version }, null, 2) + "\n");
const archive = join(dirname(destination), `tether-darwin-${process.arch}.tar.gz`);
if (await Bun.file(archive).exists()) throw new Error(`Archive already exists: ${archive}`);
const tar = Bun.spawn(["tar", "-czf", archive, "-C", destination, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
if (await tar.exited !== 0) throw new Error("Release archiving failed.");
const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
await writeFile(`${archive}.sha256`, `${hash}  tether-darwin-${process.arch}.tar.gz\n`, { flag: "wx" });
console.log(destination);
