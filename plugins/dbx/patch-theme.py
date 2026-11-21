#!/usr/bin/env python3
"""Makes DBX follow VIBE CODE's theme.

The app opens the DBX page with ?vibeTheme=light|dark (its resolved theme, "system" included). DBX's
startup script reads its theme from localStorage, which the app cannot reach from another origin, so
this patch lets the address decide and stores it where DBX reads it. Idempotent.
Usage: patch-theme.py <dist/index.html>
"""
import sys

MARK = "vibeTheme"
ANCHOR = 'cornerStyle = localStorage.getItem("dbx-corner-style");\n        } catch {}\n'
PATCH = ANCHOR + """
        // VIBE CODE: the app's theme comes in the address and wins over DBX's own setting
        try {
          const forced = new URLSearchParams(location.search).get("vibeTheme");
          if (forced === "light" || forced === "dark") {
            mode = forced;
            localStorage.setItem("dbx-theme", forced);
          }
        } catch {}
"""

path = sys.argv[1]
text = open(path, encoding="utf8").read()
if MARK in text:
    print("already patched")
elif text.count(ANCHOR) != 1:
    sys.exit("DBX startup script not found as expected; the patch needs a look")
else:
    open(path, "w", encoding="utf8").write(text.replace(ANCHOR, PATCH, 1))
    print("patched", path)
