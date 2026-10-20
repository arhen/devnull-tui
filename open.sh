#!/bin/sh
# Opens the feed beside the pane that asked for it, or focuses the pane that is
# already open in this workspace.
set -e

cd "$(dirname "$0")"

herdr="${HERDR_BIN_PATH:-herdr}"
workspace="${HERDR_WORKSPACE_ID:-}"
if [ -z "$workspace" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  workspace="$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p')"
fi

if [ -n "$workspace" ]; then
  panes="$("$herdr" pane list --workspace "$workspace" 2> /dev/null || true)"
else
  panes="$("$herdr" pane list 2> /dev/null || true)"
fi

if [ -n "$panes" ]; then
  node="$(/bin/sh ./find-node.sh)" || node=""
  if [ -n "$node" ]; then
    existing="$(printf '%s' "$panes" | "$node" lib/pane-id.js)"
    if [ -n "$existing" ] && "$herdr" plugin pane focus "$existing"; then
      exit 0
    fi
  fi
fi

# Callers differ: a pane has HERDR_PANE_ID, a plugin action carries it in its context.
pane="${HERDR_PANE_ID:-}"
if [ -z "$pane" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  pane="$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | sed -n 's/.*"focused_pane_id":"\([^"]*\)".*/\1/p')"
fi

set -- open --plugin devnull.feed --entrypoint feed --direction right --focus
if [ -n "$pane" ]; then
  set -- "$@" --target-pane "$pane"
fi

exec "$herdr" plugin pane "$@"
