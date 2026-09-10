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
  if [ "$release_version" = latest ]; then
    base=https://github.com/hartphoenix/tether/releases/latest/download
  else
    base="https://github.com/hartphoenix/tether/releases/download/$release_version"
  fi
  archive_path="$scratch/$asset"
  curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset" --output "$archive_path"
  curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset.sha256" --output "$scratch/checksum"
  expected_sha=$(awk 'NR==1 {print $1}' "$scratch/checksum")
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
"$candidate/runtime/bun" -e 'const m=await Bun.file(process.argv[1]).json(); if(m.platform!==process.platform||m.architecture!==process.arch)process.exit(1)' "$candidate/release.json"
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
  "$candidate/runtime/bun" -e 'const [old,next]=await Promise.all(process.argv.slice(1).map(p=>Bun.file(p).json()));const a=old.version.split(/[.-]/).slice(0,3).map(Number),b=next.version.split(/[.-]/).slice(0,3).map(Number);for(let i=0;i<3;i++){if(b[i]>a[i])break;if(b[i]<a[i]){console.error("Downgrade refused; restore into an isolated configuration instead.");process.exit(1)}}' "$install_root/current/release.json" "$candidate/release.json"
  status=$("$install_root/current/mdreview" daemon status)
  "$candidate/runtime/bun" -e 'const s=JSON.parse(process.argv[1]);if(!s.ok||s.data.running){console.error("Save your work and quit Tether before replacing this installation. Use tether update for backup first.");process.exit(1)}' "$status"
fi
if [ ! -d "$destination" ]; then mv "$candidate" "$destination"; fi
ln -s "$destination" "$install_root/current.new.$$"
mv -fh "$install_root/current.new.$$" "$install_root/current"
for name in tether mdreview; do
  if [ ! -L "$bin_directory/$name" ]; then ln -s "$install_root/current/$name" "$bin_directory/$name"; fi
done
"$destination/runtime/bun" -e 'await Bun.write(process.argv[1],JSON.stringify({binDirectory:process.argv[2]})+"\n")' "$install_root/install.json" "$bin_directory"
echo "Installed Tether: $destination"
echo "Launcher: $install_root/current/Open Tether.command"
case ":$PATH:" in *":$bin_directory:"*) ;; *) echo "To use tether in this shell: export PATH=\"$bin_directory:\$PATH\"" ;; esac
if [ "$open_setup" = 1 ]; then "$install_root/current/tether" setup; fi
