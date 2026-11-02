#!/usr/bin/env bash
#
# Installs the pinned wasm-opt, which rewrites the WebAssembly module that ships, so it comes from
# the official tarball with its sha256 checked. A package-manager install would run an install
# step and move frontend/package-lock.json.
#
# USAGE
#   install-wasm-opt.sh <dir>
#
# OUTPUT, on stdout only, the absolute path of the binary:
#   <dir>/wasm-opt
#
# EXIT CODES
#   0  the binary is in place and its path was printed.
#   2  no binary: a bad argument, a failed download, a tarball whose sha256 differs from the pin,
#      or a failed extract. Nothing named wasm-opt is left behind.

set -euo pipefail

VERSION="version_132"
TARBALL="binaryen-$VERSION-x86_64-linux.tar.gz"
URL="https://github.com/WebAssembly/binaryen/releases/download/$VERSION/$TARBALL"
SHA256="195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572"
MEMBER="binaryen-$VERSION/bin/wasm-opt"

if [ "$#" -ne 1 ]; then
  echo "usage: install-wasm-opt.sh <dir>" >&2
  exit 2
fi

mkdir -p "$1" || exit 2
DIR="$(cd "$1" && pwd -P)"
BINARY="$DIR/wasm-opt"

if [ -x "$BINARY" ]; then
  echo "$BINARY"
  exit 0
fi

WORK="$(mktemp -d "$DIR/install.XXXXXX")" || exit 2
fail() {
  echo "install-wasm-opt: $1" >&2
  rm -rf "$WORK"
  exit 2
}

curl -sSfL "$URL" -o "$WORK/$TARBALL" || fail "the download from $URL failed"

ACTUAL="$(sha256sum "$WORK/$TARBALL")" || fail "sha256sum failed"
ACTUAL="${ACTUAL%% *}"
if [ "$ACTUAL" != "$SHA256" ]; then
  fail "$TARBALL has sha256 $ACTUAL, and the pin is $SHA256"
fi

tar -xzf "$WORK/$TARBALL" -C "$WORK" "$MEMBER" || fail "$MEMBER didn't extract from $TARBALL"
mv "$WORK/$MEMBER" "$BINARY" || fail "couldn't move wasm-opt to $BINARY"
rm -rf "$WORK"

echo "$BINARY"
