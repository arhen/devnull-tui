#!/bin/sh
# Installs devnull without a package manager. The repository tarball (or this
# checkout, when run from one) goes under ~/.local/share/devnull, and
# ~/.local/bin/devnull links at it.
#
#   curl -fsSL https://raw.githubusercontent.com/arhen/devnull-tui/main/install.sh | sh
#
# Override with DEVNULL_HOME, DEVNULL_PREFIX and DEVNULL_REF.
set -eu

REPO="${DEVNULL_REPO:-arhen/devnull-tui}"
REF="${DEVNULL_REF:-main}"
INSTALL_DIR="${DEVNULL_HOME:-$HOME/.local/share/devnull}"
BIN_DIR="${DEVNULL_PREFIX:-$HOME/.local}/bin"

fail() {
  printf 'devnull: %s\n' "$*" >&2
  exit 1
}

node="$(command -v node || true)"
[ -n "$node" ] || fail "node 20 or newer is required: https://nodejs.org"
major="$("$node" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || true)"
[ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null ||
  fail "node 20 or newer is required (found $("$node" --version 2>/dev/null || echo none))"

work="$(mktemp -d "${TMPDIR:-/tmp}/devnull.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/app"

# Run from a checkout: install that checkout, so local edits are what lands.
source=""
if [ -f "$0" ]; then
  here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  if [ -f "$here/index.js" ] && [ -f "$here/package.json" ]; then source="$here"; fi
fi

if [ -n "$source" ]; then
  printf 'Installing from %s\n' "$source"
  (cd "$source" && tar -cf - --exclude ./.git --exclude ./node_modules .) | tar -xf - -C "$work/app"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required to download the tarball"
  url="https://codeload.github.com/$REPO/tar.gz/$REF"
  printf 'Downloading %s\n' "$url"
  curl -fsSL "$url" | tar -xz -C "$work/app" --strip-components=1 ||
    fail "could not download $url"
fi

[ -f "$work/app/index.js" ] && [ -d "$work/app/lib" ] || fail "the download is missing index.js or lib/"
chmod +x "$work/app/index.js"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
for item in index.js lib package.json LICENSE README.md run.sh open.sh find-node.sh herdr-plugin.toml; do
  [ -e "$work/app/$item" ] && cp -R "$work/app/$item" "$INSTALL_DIR/"
done
ln -sf "$INSTALL_DIR/index.js" "$BIN_DIR/devnull"

version="$("$BIN_DIR/devnull" --version 2>/dev/null || true)"
[ -n "$version" ] || fail "installed, but $BIN_DIR/devnull did not run"

printf 'devnull %s installed\n' "$version"
printf '  binary  %s\n' "$BIN_DIR/devnull"
printf '  files   %s\n' "$INSTALL_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\nAdd %s to PATH to run devnull from anywhere.\n' "$BIN_DIR" ;;
esac
