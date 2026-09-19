#!/usr/bin/env bash
set -e

# Load shim and export gsd_run so subsequent commands can use it
source <(bash D:/Claude/Grokbot/.gsd/init-shim.sh 2>&1 | head -1)
# Manually re-export from the inline script logic
GSD_TOOLS="C:/Users/simth/.claude/gsd-core/bin/gsd-tools.cjs"
export GSD_TOOLS
gsd_run() { node "$GSD_TOOLS" "$@"; }
export -f gsd_run

"$@"