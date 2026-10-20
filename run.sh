#!/bin/sh
# Herdr starts plugin commands without a shell: resolve the runtime, then run.
set -e

cd "$(dirname "$0")"

node="$(./find-node.sh)" || {
  printf 'devnull.feed: could not find node.\n' >&2
  printf 'Set DEVNULL_NODE=/path/to/node (18 or newer) and reopen the pane.\n' >&2
  printf 'Press any key to close.\n' >&2
  read -r _ 2> /dev/null || sleep 60
  exit 1
}

exec "$node" index.js "$@"
