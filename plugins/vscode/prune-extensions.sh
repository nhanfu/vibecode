#!/usr/bin/env bash
# Drops the built-in extensions a review-and-diff workflow does not use, from server/extensions.
# Language support stays whole: every *-language-features extension (the language servers), every
# grammar (*-basics and the per-language ones: a few KB each), git, diff, merge-conflict,
# references-view, search-result, the Seti icons, the default themes and the settings.json schema.
# Used by build.sh; run it by hand on a server/ that is already built. Idempotent.
# Usage: prune-extensions.sh <server/extensions>
set -euo pipefail

EXT="${1:?usage: prune-extensions.sh <server/extensions>}"
[ -d "$EXT" ] || { echo "no such folder: $EXT" >&2; exit 1; }

DROP=(
  # debugging (a debugger and its profiler views)
  debug-auto-launch debug-server-ready ms-vscode.js-debug ms-vscode.js-debug-companion ms-vscode.vscode-js-profile-table
  # accounts, GitHub, tunnels
  microsoft-authentication github-authentication github tunnel-forwarding
  # notebooks, chat extras, markdown math
  ipynb notebook-renderers mermaid-chat-features prompt-basics markdown-math
  # task detectors (they scan the workspace for gulp / grunt / jake / npm scripts)
  grunt gulp jake npm
  # other
  simple-browser terminal-suggest extension-editing emmet
  # colour themes besides the default ones
  theme-2026 theme-abyss theme-kimbie-dark theme-monokai theme-monokai-dimmed theme-quietlight theme-red
  theme-solarized-dark theme-solarized-light theme-tomorrow-night-blue
)

# an extension that is kept must not need one that goes
python3 - "$EXT" "${DROP[@]}" <<'PY'
import json, os, sys
ext, drop = sys.argv[1], set(sys.argv[2:])
ids = {}
for name in os.listdir(ext):
    p = os.path.join(ext, name, 'package.json')
    if os.path.isfile(p):
        m = json.load(open(p, encoding='utf8'))
        ids[f"{m.get('publisher', '')}.{m.get('name', '')}".lower()] = name
bad = []
for name in os.listdir(ext):
    p = os.path.join(ext, name, 'package.json')
    if name in drop or not os.path.isfile(p):
        continue
    for dep in json.load(open(p, encoding='utf8')).get('extensionDependencies', []):
        if ids.get(dep.lower()) in drop:
            bad.append(f"{name} needs {dep}")
if bad:
    sys.exit("pruning would break: " + "; ".join(bad))
PY

for name in "${DROP[@]}"; do
  rm -rf "${EXT:?}/$name"
done
echo "extensions: $(ls "$EXT" | wc -l) kept, $(du -sh "$EXT" | cut -f1)"
