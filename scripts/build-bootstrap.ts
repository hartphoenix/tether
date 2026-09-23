import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Archive = { architecture: "arm64" | "x64"; sha256: string };

/** Hashes and URLs belong to this versioned installer, never a downloaded sidecar. */
export function renderBootstrap(version: string, archives: Archive[], installer: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !archives.length) throw new Error("A stable version and at least one archive are required.");
  const seen = new Set<string>();
  const cases = archives.map(({ architecture, sha256 }) => {
    if (!["arm64", "x64"].includes(architecture) || !/^[a-f0-9]{64}$/.test(sha256) || seen.has(architecture)) throw new Error("Invalid or duplicate bootstrap archive.");
    seen.add(architecture);
    return `    ${architecture === "x64" ? "x86_64" : "arm64"}) asset=tether-darwin-${architecture}.tar.gz; expected_sha=${sha256} ;;`;
  }).join("\n");
  return `#!/bin/bash
# Tether ${version}. Generated from the release archives; publish only after approval.
set -euo pipefail
# Define the whole entry point before running it, including when piped to bash.
tether_bootstrap() {
  local no_open=""
  case "\${1:-}" in
    --help) echo 'Usage: bash install.sh [--no-open]'; return ;;
    --no-open) no_open=--no-open; shift ;;
  esac
  [ "$#" -eq 0 ] || { echo 'Unknown installer arguments.' >&2; return 2; }
  [ "$(uname -s)" = Darwin ] || { echo 'Tether currently supports macOS only.' >&2; return 1; }
  local asset expected_sha
  case "$(uname -m)" in
${cases}
    *) echo 'This release has no package for your Mac architecture.' >&2; return 1 ;;
  esac
  local install_root="\${TETHER_INSTALL_DIR:-$HOME/.local/share/tether}"
  if [ -x "$install_root/current/mdreview" ]; then
    # Existing installations keep their signed update chain, even from an old bootstrap.
    local current_root
    current_root=$(cd "$install_root/current" && pwd -P)
    TETHER_INSTALL_ROOT="$current_root" "$current_root/runtime/bun" --no-env-file "$current_root/lib/cli.js" update
    return
  fi
  local download_dir
  download_dir=$(mktemp -d)
  echo 'Downloading Tether ${version}…'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 \\
    "https://github.com/hartphoenix/tether/releases/download/v${version}/$asset" --output "$download_dir/$asset"
  # The embedded installer verifies the archive before extracting or running anything.
  /bin/bash -s -- --archive "$download_dir/$asset" --sha256 "$expected_sha" --version v${version} \${no_open:+"$no_open"} <<'TETHER_PACKAGE_INSTALLER'
${installer.trimEnd()}
TETHER_PACKAGE_INSTALLER
}
tether_bootstrap "$@"
`;
}

export async function buildBootstrap(version: string, output: string, paths: string[]): Promise<void> {
  const archives: Archive[] = [];
  for (const path of paths) {
    const child = Bun.spawn(["/usr/bin/tar", "-xOf", resolve(path), "./release.json"], { stdout: "pipe", stderr: "pipe" });
    const [metadata, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Cannot inspect release: ${error}`);
    const release = JSON.parse(metadata);
    if (release.version !== version || release.platform !== "darwin" || !["arm64", "x64"].includes(release.architecture)) throw new Error("Bootstrap archives must match the release version and platform.");
    const sha256 = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
    archives.push({ architecture: release.architecture, sha256 });
  }
  const installer = await readFile(new URL("./install.sh", import.meta.url), "utf8");
  await writeFile(output, renderBootstrap(version, archives, installer), { flag: "wx", mode: 0o755 });
}

if (import.meta.main) {
  const [version, output, ...archives] = process.argv.slice(2);
  if (!version || !output || !archives.length) throw new Error("Usage: bun scripts/build-bootstrap.ts <version> <output-install.sh> <archive> [archive...]");
  await buildBootstrap(version, output, archives);
}
