#!/bin/sh
# Prints a node (20 or newer) to run the plugin with, or exits 1.
# Herdr launches plugin commands without a shell, so PATH may be the server's
# and miss the user's version manager: look where those put node.
set -e

usable() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)' > /dev/null 2>&1
}

if [ -n "${DEVNULL_NODE:-}" ] && usable "$DEVNULL_NODE"; then
  printf '%s\n' "$DEVNULL_NODE"
  exit 0
fi

if command -v node > /dev/null 2>&1 && usable "$(command -v node)"; then
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
  "$HOME/.fnm/aliases/default/bin/node"; do
  if usable "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

# nvm keeps every version; take the highest one that is new enough.
best=""
bestpath=""
for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
  usable "$candidate" || continue
  version="${candidate#*/.nvm/versions/node/}"
  version="${version%%/*}"
  version="${version#v}"
  if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$version" ]; then
    best="$version"
    bestpath="$candidate"
  fi
done

if [ -n "$bestpath" ]; then
  printf '%s\n' "$bestpath"
  exit 0
fi

exit 1
