import { buildMacServiceApp } from "./macos-service-app";
import { chmod, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildWeb } from "../src/web/build";
import { buildPaseoPlugin } from "./build-paseo-plugin";
import { buildBootstrap } from "./build-bootstrap";
import { version as packageVersion } from "../package.json";
const version = process.argv[3] ?? packageVersion;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable release version.");

if (process.platform !== "darwin") throw new Error("Release builds currently support macOS only.");
const destination = resolve(process.argv[2] ?? `dist/release/tether-${version}-darwin-${process.arch}`);
// Exclusive directory: never overwrite a previous candidate or its evidence.
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
await mkdir(join(destination, "runtime"));
await buildMacServiceApp(join(destination, "tether.app"), process.execPath, "org.tether.desktop");
// Preserve the runtime contract while every Tether-owned child uses the branded executable.
await writeFile(join(destination, "runtime/bun"), '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/tether.app/Contents/MacOS/tether" "$@"\n', { mode: 0o755 });
const entries = {
  "update-agent-skills": "scripts/update-agent-skills.ts",
  login: "src/server/login.ts",
  cli: "src/cli/main.ts", public: "src/cli/public.ts", daemon: "src/server/daemon.ts",
  "wave-bridge": "src/hosts/wave-bridge-daemon.ts", "cmux-bridge": "src/hosts/cmux-bridge-daemon.ts",
};
for (const [name, entry] of Object.entries(entries)) {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", external: ["playwright"], outdir: join(destination, "lib"), naming: `${name}.js` });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
await buildWeb(join(destination, "dist"));
await copyFile("src/web/favicon.png", join(destination, "dist/favicon.png"));
await mkdir(join(destination, "docs"));
await copyFile("docs/getting-started.md", join(destination, "docs/getting-started.md"));
// Setup copies these notes into the user's documents after installation.
await mkdir(join(destination, "docs/releases"));
await copyFile(`docs/releases/${version}.md`, join(destination, `docs/releases/${version}.md`));
// The release notes link to the Paseo guide; setup copies it beside them.
await mkdir(join(destination, "docs/guide"));
await copyFile("docs/guide/paseo.md", join(destination, "docs/guide/paseo.md"));
// Brand source files (docs/assets/brand) are for design work, not the runtime.
await cp("docs/assets", join(destination, "docs/assets"), { recursive: true, filter: source => basename(source) !== "brand" });
await cp("integrations/agents", join(destination, "integrations/agents"), { recursive: true });
await buildPaseoPlugin(join(destination, "integrations/paseo"), version);
await copyFile("LICENSE", join(destination, "LICENSE"));
await mkdir(join(destination, "licenses"));
await copyFile("licenses/lucide-icons-LICENSE.txt", join(destination, "licenses/lucide-icons-LICENSE.txt"));
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
// Explicit directory containing public trust material only. Never infer signing keys.
if (process.argv[4]) {
  for (const name of ["update-root.json", "update-trust.json"]) await copyFile(join(resolve(process.argv[4]), name), join(destination, name));
}
for (const [name, entry] of [["tether", "public"], ["mdreview", "cli"], ["Open Tether.command", "public"]]) {
  const launcher = `#!/bin/zsh\nset -euo pipefail\nexport TETHER_INSTALL_ROOT="\${0:A:h}"\nexec "$TETHER_INSTALL_ROOT/runtime/bun" --no-env-file "$TETHER_INSTALL_ROOT/lib/${entry}.js" "$@"\n`;
  await writeFile(join(destination, name!), launcher, { mode: 0o755 });
}
await writeFile(join(destination, "release.json"), JSON.stringify({ version, platform: process.platform, architecture: process.arch, runtime: Bun.version }, null, 2) + "\n");
const archive = join(dirname(destination), `tether-darwin-${process.arch}.tar.gz`);
if (await Bun.file(archive).exists()) throw new Error(`Archive already exists: ${archive}`);
const tar = Bun.spawn(["tar", "-czf", archive, "-C", destination, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
if (await tar.exited !== 0) throw new Error("Release archiving failed.");
const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
await writeFile(`${archive}.sha256`, `${hash}  tether-darwin-${process.arch}.tar.gz\n`, { flag: "wx" });
await buildBootstrap(version, join(dirname(destination), "install.sh"), [archive]);
console.log(destination);
