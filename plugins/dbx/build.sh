#!/usr/bin/env bash
# Builds the DBX plugin: bin/dbx-web (DBX's HTTP server with every database driver) and dist/ (its UI).
# DBX is Apache-2.0 (https://github.com/t8y2/dbx); its LICENSE is copied next to the binary.
# Needs: git, cargo (Rust >= 1.88), pnpm, node. Takes several minutes the first time.
# Usage: plugins/dbx/build.sh [work-dir]     (work-dir keeps the clone + cargo target between runs)
set -euo pipefail

DBX_REF="${DBX_REF:-4447e07c5bf4580246498769527457849b3009f3}" # dbx 0.6.72
OUT="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/vibe-dbx-build}"

mkdir -p "$WORK"
if [ ! -d "$WORK/dbx/.git" ]; then
  git clone https://github.com/t8y2/dbx "$WORK/dbx"
fi
git -C "$WORK/dbx" fetch --depth 1 origin "$DBX_REF" 2>/dev/null || true
git -C "$WORK/dbx" checkout --quiet "$DBX_REF"

(cd "$WORK/dbx" && pnpm install --frozen-lockfile && pnpm build)
(cd "$WORK/dbx" && cargo build -p dbx-web --release)

rm -rf "$OUT/dist" "$OUT/bin"
mkdir -p "$OUT/bin"
cp -r "$WORK/dbx/dist" "$OUT/dist"
EXE=dbx-web
[ -f "$WORK/dbx/target/release/dbx-web.exe" ] && EXE=dbx-web.exe
cp "$WORK/dbx/target/release/$EXE" "$OUT/bin/$EXE"
cp "$WORK/dbx/LICENSE" "$OUT/LICENSE-dbx"
# DBX follows the app's theme (see patch-theme.py)
python3 "$OUT/patch-theme.py" "$OUT/dist/index.html"
python3 "$OUT/../patch-keys.py" "$OUT/dist/index.html"
echo "DBX built into $OUT"
