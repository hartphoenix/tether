#!/bin/zsh
set -euo pipefail

# Finder starts .command files with a minimal PATH. Keep the launcher movable
# by deriving the source checkout from this file instead of the current shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
if [[ -x "${HOME}/.bun/bin/bun" ]]; then
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

launcher_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec "${launcher_dir}/mdreview" folio
