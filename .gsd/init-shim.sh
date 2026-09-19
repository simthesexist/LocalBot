#!/usr/bin/env bash
set -e

_GSD_SHIM_NAME="gsd-tools.cjs"
_GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"

_gsd_at() {
  for _p; do
    if [ -f "$_p" ]; then
      GSD_TOOLS="$_p"
      return 0
    fi
  done
  return 1
}

if _gsd_at \
    "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then
  gsd_run() { node "$GSD_TOOLS" "$@"; }
elif unset -f gsd_run && _G="$(command -v gsd_run)"; then
  GSD_TOOLS="$_G"
  gsd_run() { "$GSD_TOOLS" "$@"; }
elif _gsd_at \
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${CLAUDE_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" \
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; then
  gsd_run() { node "$GSD_TOOLS" "$@"; }
else
  echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH." >&2
  exit 1
fi

export -f gsd_run
echo "GSD tools: $GSD_TOOLS"
gsd_run runtime-identity --verbose 2>&1 | head -20