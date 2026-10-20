#!/bin/sh
# Herdr starts plugin commands without a shell, so this resolves node the way
# an interactive shell would and hands the arguments over unchanged.
set -e
cd "$(dirname "$0")"
exec node index.js "$@"
