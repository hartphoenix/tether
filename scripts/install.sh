#!/bin/bash
set -euo pipefail

# Downloads are GET-only. No sudo or shell-profile changes.
release_version=latest
install_root="${TETHER_INSTALL_DIR:-$HOME/.local/share/tether}"
bin_directory="${TETHER_BIN_DIR:-$HOME/.local/bin}"
archive_path=
expected_sha=
open_setup=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) release_version="${2:?Missing version}"; shift 2 ;;
    --archive) archive_path="${2:?Missing archive}"; shift 2 ;;
    --sha256) expected_sha="${2:?Missing checksum}"; shift 2 ;;
    --no-open) open_setup=0; shift ;;
    --help) echo 'Usage: bash install.sh [--version vX.Y.Z] [--archive file --sha256 hash] [--no-open]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo 'Tether currently supports macOS only.' >&2; exit 1; }
case "$(uname -m)" in arm64) architecture=arm64 ;; x86_64) architecture=x64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
if [ "$release_version" != latest ] && ! [[ "$release_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]]; then echo 'Invalid release version.' >&2; exit 2; fi
case "$install_root:$bin_directory" in /*:/*) ;; *) echo 'Installation paths must be absolute.' >&2; exit 2 ;; esac
scratch=$(mktemp -d)
# Keep failed candidates available for diagnosis; nothing recursively deleted.
asset="tether-darwin-$architecture.tar.gz"
if [ -z "$archive_path" ]; then
  if [ -x "$install_root/current/mdreview" ]; then
    current_root=$(cd "$install_root/current" && pwd -P)
    export TETHER_INSTALL_ROOT="$current_root"
    if [ "$release_version" = latest ]; then exec "$current_root/runtime/bun" --no-env-file "$current_root/lib/cli.js" update; fi
    exec "$current_root/runtime/bun" --no-env-file "$current_root/lib/cli.js" update --version "$release_version"
  fi
  echo 'First installation requires a publisher-authenticated archive and independently authenticated SHA-256 digest. Network bootstrap is not configured.' >&2
  exit 1
fi
[[ "$expected_sha" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'A SHA-256 checksum is required.' >&2; exit 1; }
actual_sha=$(shasum -a 256 "$archive_path" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || { echo 'Release checksum mismatch.' >&2; exit 1; }
# Reject traversal and links before extracting a trusted release archive.
tar -tzf "$archive_path" > "$scratch/contents"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}' "$scratch/contents"; then
  echo 'Unsafe archive paths.' >&2; exit 1
fi
if tar -tvzf "$archive_path" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {bad=1} END {exit !bad}'; then
  echo 'Archive links or special files are not supported.' >&2; exit 1
fi
mkdir "$scratch/candidate"
tar -xzf "$archive_path" -C "$scratch/candidate"
candidate="$scratch/candidate"
[ -x "$candidate/tether" ] && [ -x "$candidate/runtime/bun" ] && [ -f "$candidate/release.json" ] || { echo 'Incomplete release.' >&2; exit 1; }
[ "$(/usr/bin/plutil -extract platform raw -o - "$candidate/release.json")" = darwin ] && [ "$(/usr/bin/plutil -extract architecture raw -o - "$candidate/release.json")" = "$architecture" ] || { echo 'Wrong release platform.' >&2; exit 1; }
candidate_version=$(/usr/bin/plutil -extract version raw -o - "$candidate/release.json")
[[ "$candidate_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid candidate version.' >&2; exit 1; }
[ "$release_version" = latest ] || [ "$release_version" = "v$candidate_version" ] || { echo 'Candidate version differs from authenticated metadata.' >&2; exit 1; }
mkdir -p "$install_root/releases" "$bin_directory"
install_root=$(cd "$install_root" && pwd -P)
bin_directory=$(cd "$bin_directory" && pwd -P)
for name in tether mdreview; do
  if [ -e "$bin_directory/$name" ] || [ -L "$bin_directory/$name" ]; then
    [ -L "$bin_directory/$name" ] && [ "$(readlink "$bin_directory/$name")" = "$install_root/current/$name" ] || { echo "Existing command preserved: $bin_directory/$name" >&2; exit 1; }
  fi
done
if [ -e "$install_root/current" ] && [ ! -L "$install_root/current" ]; then
  echo 'Existing current path is not a Tether symlink; preserved.' >&2; exit 1
fi
destination="$install_root/releases/$actual_sha"
if [ -L "$install_root/current" ] && [ "$(readlink "$install_root/current")" != "$destination" ]; then
  "$candidate/runtime/bun" --no-env-file -e 'const [old,next]=await Promise.all(process.argv.slice(1).map(p=>Bun.file(p).json()));const a=old.version.split(/[.-]/).slice(0,3).map(Number),b=next.version.split(/[.-]/).slice(0,3).map(Number);for(let i=0;i<3;i++){if(b[i]>a[i])break;if(b[i]<a[i]){console.error("Downgrade refused; restore into an isolated configuration instead.");process.exit(1)}}' "$install_root/current/release.json" "$candidate/release.json"
  current_root=$(cd "$install_root/current" && pwd -P)
  status=$(TETHER_INSTALL_ROOT="$current_root" "$current_root/runtime/bun" --no-env-file "$current_root/lib/cli.js" daemon status)
  "$candidate/runtime/bun" --no-env-file -e 'const s=JSON.parse(process.argv[1]);if(!s.ok||s.data.running){console.error("Save your work and quit Tether before replacing this installation. Use tether update for backup first.");process.exit(1)}' "$status"
  if [ -f "$current_root/lib/login.js" ]; then
    startup_status=$(TETHER_INSTALL_ROOT="$current_root" "$current_root/runtime/bun" --no-env-file "$current_root/lib/cli.js" startup status)
    "$candidate/runtime/bun" --no-env-file -e 'const s=JSON.parse(process.argv[1]);if(!s.ok||s.data.enabled){console.error("Disable login startup before replacing this installation: tether startup disable");process.exit(1)}' "$startup_status"
  fi
fi
if [ ! -d "$destination" ]; then mv "$candidate" "$destination"; fi
ln -s "$destination" "$install_root/current.new.$$"
mv -fh "$install_root/current.new.$$" "$install_root/current"
for name in tether mdreview; do
  if [ ! -L "$bin_directory/$name" ]; then ln -s "$install_root/current/$name" "$bin_directory/$name"; fi
done
"$destination/runtime/bun" --no-env-file -e 'await Bun.write(process.argv[1],JSON.stringify({binDirectory:process.argv[2]})+"\n")' "$install_root/install.json" "$bin_directory"
if [ -f "$destination/lib/update-agent-skills.js" ]; then
  TETHER_INSTALL_ROOT="$destination" "$destination/runtime/bun" --no-env-file "$destination/lib/update-agent-skills.js"
fi
echo "Installed Tether: $destination"
echo "Launcher: $install_root/current/Open Tether.command"
case ":$PATH:" in *":$bin_directory:"*) ;; *) echo "To use tether in this shell: export PATH=\"$bin_directory:\$PATH\"" ;; esac
if [ "$open_setup" = 1 ]; then "$install_root/current/tether" setup; fi
