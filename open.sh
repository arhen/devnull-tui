#!/bin/sh
# Opens the feed pane beside the pane that asked for it.
set -e

herdr="${HERDR_BIN_PATH:-herdr}"

set -- open --plugin devnull.feed --entrypoint feed --direction right --focus
if [ -n "${HERDR_PANE_ID:-}" ]; then
  set -- "$@" --target-pane "$HERDR_PANE_ID"
fi

exec "$herdr" plugin pane "$@"
