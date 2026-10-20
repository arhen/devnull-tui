#!/bin/sh
# Herdr starts plugin commands without a shell: resolve the runtime, then run.
set -e

cd "$(dirname "$0")"

node="$(/bin/sh ./find-node.sh)" || {
  printf 'devnull.feed: could not find node 20 or newer.\n' >&2
  printf 'Set DEVNULL_NODE=/path/to/node and reopen the pane.\n' >&2
  if [ -t 0 ]; then
    printf 'Press Enter to close.\n' >&2
    read -r _
  fi
  exit 1
}

exec "$node" index.js "$@"
