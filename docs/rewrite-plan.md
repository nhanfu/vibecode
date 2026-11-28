# Rewrite plan: the app is a plugin manager

Branch: `plugin-rewrite` (same worktree as before, started from `project-switch-single-layout`).

## Principles

1. **The app is a plugin manager.** The core loads plugins, shows their panels, and routes their commands. It knows no agent, no editor, no browser.
2. **Everything is a plugin**, including the agent. The agent plugin reuses **herdr**: herdr owns the agent sessions, panes and detach/reattach; the plugin only starts and shows it.
3. **Terminal = the OS terminal.** The plugin wraps the system's own terminal emulator (the one the user already runs) rather than drawing a terminal in a library (no xterm.js, no ghostty-web). This removes per-byte work in the webview.
4. **Performance is a gate, not a final check.** Each step is measured before the next one starts, and the numbers are kept in `docs/perf/` so a slow drift shows up.

## Performance baseline (measure before changing anything)

Record for the current app (`project-switch-single-layout`) and keep the numbers in `docs/perf/baseline.md`:

| Metric | How |
| --- | --- |
| Cold start to first frame | time from launch to first `frame published` in the zero-native log |
| Idle memory (RSS) | `ps -o rss= -p <pid>` after 60 s idle, with 0 and with 3 chats |
| Renderer bundle size | sizes of `out/renderer/assets/*.js` (gzip too) |
| Terminal throughput | `yes | head -c 50M` in a chat, time until the chat is idle |
| Bridge round trips | count of `bridge request handled` per second while idle (should be ~0) |

## Steps

Each step ends with its numbers in `docs/perf/` and a comparison with the previous step. A step that makes a metric worse needs a reason written down before the next step begins.

1. **Measure the baseline.** No code changes. Fill in the table above.
2. **Plugin manager core.** Discover plugins (`plugin.json`), list them, enable/disable, show each plugin's panel. No agent, no terminal in the core.
3. **Plugin contract.** Define what a plugin can declare (panel, command, sidecar). Keep it the same as `docs/plugins.md` where it works, and change it only with a reason written down.
4. **Agent plugin on herdr.** Start `herdr` for a folder, show it in a panel. Measure the same metrics as in the baseline.
5. **OS terminal wrap.** Start the system terminal running herdr (no terminal library in the webview). Measure input latency and throughput against step 4.
6. **Remove what is no longer used.** Delete the old xterm/ghostty code, the old chat layout, and the agent code that moved to the plugin. Measure the bundle size and RSS again.

## Open questions

- How the OS terminal is found and launched on each platform (Linux first).
- Whether the core stays in zero-native (Zig) or moves to a smaller shell.
- Where the plugin manager's own UI lives (webview page or native).
