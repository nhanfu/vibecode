#!/usr/bin/env bash
# Builds the VS Code plugin's program into server/ (bin/openvscode-server and its Node.js).
#
# Two ways, chosen in plugin.json under "source":
#   - "git" empty: download the openvscode-server release for this system (fast, no toolchain).
#   - "git" set:   clone that repository (at "ref", optional), run "build" in it, and copy its
#                  "output" folder (relative to the clone) to server/. Use this to edit the source.
#
# Needs: curl, tar (release) or git, and whatever "build" needs (git source).
# Usage: plugins/vscode/build.sh
set -euo pipefail

OUT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$OUT/plugin.json"

field() { python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m.get(sys.argv[2], {}).get(sys.argv[3], "") if sys.argv[2] == "source" else m.get(sys.argv[2], ""))' "$MANIFEST" "$1" "${2:-}"; }
VERSION="${OPENVSCODE_VERSION:-$(field version)}"
GIT="$(field source git)"
REF="$(field source ref)"
BUILD="$(field source build)"
OUTPUT="$(field source output)"

die() { echo "vscode plugin: $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -z "$GIT" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) TARGET=linux-x64 ;;
    Linux-aarch64) TARGET=linux-arm64 ;;
    Darwin-x86_64) TARGET=darwin-x64 ;;
    Darwin-arm64) TARGET=darwin-arm64 ;;
    *) die "no openvscode-server release for $(uname -s) $(uname -m)" ;;
  esac
  URL="https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${VERSION}/openvscode-server-v${VERSION}-${TARGET}.tar.gz"
  echo "downloading openvscode-server ${VERSION} (${TARGET})"
  curl -fsSL -o "$TMP/oss.tar.gz" "$URL"
  tar -xzf "$TMP/oss.tar.gz" -C "$TMP"
  BUILT="$TMP/openvscode-server-v${VERSION}-${TARGET}"
else
  [ -n "$BUILD" ] || die 'source.build is empty: set the command that builds the server in plugin.json'
  [ -n "$OUTPUT" ] || die 'source.output is empty: set the folder (relative to the clone) that holds bin/openvscode-server'
  SRC="$OUT/source"
  if [ -d "$SRC/.git" ]; then
    echo "updating $SRC"
    git -C "$SRC" fetch --quiet origin
  else
    echo "cloning $GIT into $SRC"
    git clone --quiet "$GIT" "$SRC"
  fi
  if [ -n "$REF" ]; then
    git -C "$SRC" checkout --quiet "$REF"
  fi
  # on a branch: take its latest commit (fails quietly when detached at a tag or commit)
  git -C "$SRC" pull --quiet --ff-only 2>/dev/null || true
  echo "building in $SRC: $BUILD"
  (cd "$SRC" && bash -c "$BUILD")
  BUILT="$SRC/$OUTPUT"
fi

[ -f "$BUILT/bin/openvscode-server" ] || die "no bin/openvscode-server in $BUILT"

rm -rf "$OUT/server"
mkdir -p "$OUT/server"
cp -r "$BUILT"/. "$OUT/server/"
[ -f "$OUT/server/LICENSE" ] && cp "$OUT/server/LICENSE" "$OUT/LICENSE-openvscode-server"
# fewer built-in extensions: less to start, less memory (the language servers stay, see prune-extensions.sh)
bash "$OUT/prune-extensions.sh" "$OUT/server/extensions"
# the page follows the app's theme and settings (see patch-theme.py)
python3 "$OUT/patch-theme.py" "$OUT/server/out/vs/code/browser/workbench/workbench.html"
echo "server ready in $OUT/server"
