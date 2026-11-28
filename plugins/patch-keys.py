#!/usr/bin/env python3
"""Adds the app's key forwarding to a plugin's page (see docs/plugin-keys-forward.js).

Without it, F11 and Ctrl+Shift+←/→ pressed while the page has the focus never reach VIBE CODE.
The script goes first in <head>, so it runs before the page's own key handlers. Idempotent.
Usage: patch-keys.py <page.html>
"""
import os
import sys

MARK = "VIBE CODE: keys forwarded to the app"
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "plugin-keys-forward.js")


def main() -> None:
    page = sys.argv[1]
    html = open(page, encoding="utf-8").read()
    if MARK in html:
        print(f"{page}: already patched")
        return
    code = open(SCRIPT, encoding="utf-8").read()
    block = f"<script>\n// {MARK} (plugins/patch-keys.py)\n{code}</script>\n"
    head = html.find("<head>")
    if head < 0:
        sys.exit(f"{page}: no <head>")
    at = head + len("<head>")
    open(page, "w", encoding="utf-8").write(html[:at] + "\n" + block + html[at:])
    print(f"{page}: patched")


if __name__ == "__main__":
    main()
