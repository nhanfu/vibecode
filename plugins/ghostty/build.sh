#!/usr/bin/env bash
# Builds the Ghostty terminal plugin: bin/libvibe-terminal.so, a native library the app loads into its process.
# It needs libghostty-vt, the vendored submodule: git submodule update --init --depth 1 native/vendor/libghostty-vt
set -euo pipefail
cd "$(dirname "$0")"
GHOSTTY="${GHOSTTY_VT:-../../native/vendor/libghostty-vt}"
if [ ! -f "$GHOSTTY/build.zig" ]; then
  echo "libghostty-vt is missing at $GHOSTTY: git submodule update --init --depth 1 native/vendor/libghostty-vt" >&2
  exit 1
fi
if [ ! -f "$GHOSTTY/zig-out/lib/libghostty-vt.a" ]; then
  (cd "$GHOSTTY" && zig build -Demit-lib-vt -Doptimize=ReleaseFast)
fi
mkdir -p bin
zig build-obj -OReleaseFast -fPIC src/termcore.zig -lc -I"$GHOSTTY/include" -femit-bin=bin/termcore.o
gcc -shared -fPIC -O2 -Wall -I src src/plugin.c bin/termcore.o "$GHOSTTY/zig-out/lib/libghostty-vt.a" \
  $(pkg-config --cflags --libs gtk4 pangocairo) -lutil -o bin/libvibe-terminal.so
rm -f bin/termcore.o
echo "built bin/libvibe-terminal.so"

# The release archive: one top folder, as the app's installer expects (plugin.json inside it).
VERSION="$(python3 -c 'import json; print(json.load(open("plugin.json"))["version"])')"
PKG=dist/ghostty
rm -rf dist && mkdir -p "$PKG/bin"
cp plugin.json "$PKG/"
cp bin/libvibe-terminal.so "$PKG/bin/"
cp src/vibe_plugin.h "$PKG/"
cp "$GHOSTTY/LICENSE" "$PKG/LICENSE-libghostty"
ARCHIVE="dist/ghostty-$VERSION-linux-x64.tar.gz"
tar -czf "$ARCHIVE" -C dist ghostty
sha256sum "$ARCHIVE"
