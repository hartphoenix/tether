import { chmod, copyFile, mkdir, writeFile, rename, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Local ad-hoc signing establishes bundle integrity, not a verified publisher. */
export async function buildMacServiceApp(app: string, runtime: string, identifier: string, icon = join(import.meta.dir, "../docs/assets/tether.icns")) {
  if (process.platform !== "darwin") throw new Error("A macOS service app requires macOS.");
  const staging = join(dirname(app), `.tether-${crypto.randomUUID()}.app`);
  const contents = join(staging, "Contents"), executable = join(contents, "MacOS/tether");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await copyFile(runtime, executable);
  await chmod(executable, 0o755);
  await copyFile(icon, join(contents, "Resources/tether.icns"));
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(identifier)}</string>
<key>CFBundleName</key><string>tether</string>
<key>CFBundleDisplayName</key><string>tether</string>
<key>CFBundleExecutable</key><string>tether</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>tether.icns</string>
<key>LSUIElement</key><true/>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`);
  const frameworks = join(contents, "Frameworks");
  await mkdir(frameworks);
  const native = join(frameworks, "tether-identity.dylib");
  const compile = Bun.spawn(["/usr/bin/clang", "-dynamiclib", "-framework", "AppKit", join(import.meta.dir, "native/service-identity.m"), "-o", native], { stdout: "pipe", stderr: "pipe" });
  const [compileCode, compileError] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (compileCode !== 0) throw new Error(`Service identity compilation failed: ${compileError}`);
  const controller = join(frameworks, "tether-service");
  const controllerBuild = Bun.spawn(["/usr/bin/clang", "-mmacosx-version-min=13.0", "-framework", "AppKit", "-framework", "ServiceManagement", join(import.meta.dir, "native/service-controller.m"), "-o", controller], { stdout: "pipe", stderr: "pipe" });
  const [controllerCode, controllerError] = await Promise.all([controllerBuild.exited, new Response(controllerBuild.stderr).text()]);
  if (controllerCode !== 0) throw new Error(`Service controller compilation failed: ${controllerError}`);
  const controllerSign = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", controller], { stdout: "pipe", stderr: "pipe" });
  const [controllerSignCode, controllerSignError] = await Promise.all([controllerSign.exited, new Response(controllerSign.stderr).text()]);
  if (controllerSignCode !== 0) throw new Error(`Service controller signing failed: ${controllerSignError}`);
  const nativeSign = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", native], { stdout: "pipe", stderr: "pipe" });
  const [nativeCode, nativeError] = await Promise.all([nativeSign.exited, new Response(nativeSign.stderr).text()]);
  if (nativeCode !== 0) throw new Error(`Native identity signing failed: ${nativeError}`);
  // Replace the runtime vendor's signature; never attribute Tether to that vendor.
  // "-" is a local ad-hoc identity and does not access signing credentials.
  const sign = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", staging], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([sign.exited, new Response(sign.stderr).text()]);
  if (code !== 0) throw new Error(`Local bundle signing failed: ${error}`);
  const existing = await lstat(app).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("The service app must be a real directory.");
  const previous = `${app}.previous-${crypto.randomUUID()}`;
  if (existing) await rename(app, previous);
  try { await rename(staging, app); }
  catch (error) { if (existing) await rename(previous, app); throw error; }
  if (existing) await rm(previous, { recursive: true });
  return join(app, "Contents/MacOS/tether");
}
