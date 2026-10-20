#!/bin/sh
# Prints the node (or bun) to run the plugin with, or exits 1.
# Herdr launches plugin commands without a shell, so PATH may be the server's
# and miss the user's version manager: look where those put node.
set -e

if [ -n "${DEVNULL_NODE:-}" ] && [ -x "$DEVNULL_NODE" ]; then
  printf '%s\n' "$DEVNULL_NODE"
  exit 0
fi

if command -v node > /dev/null 2>&1; then
  command -v node
  exit 0
fi

for candidate in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.local/bin/node" \
  "$HOME/.volta/bin/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$HOME/.asdf/shims/node" \
  "$HOME/.fnm/aliases/default/bin/node" \
  "$HOME/.bun/bin/bun"; do
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

# nvm keeps every version; take the last (highest) one.
for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -x "$candidate" ]; then
    node="$candidate"
  fi
done
if [ -n "${node:-}" ]; then
  printf '%s\n' "$node"
  exit 0
fi

exit 1
