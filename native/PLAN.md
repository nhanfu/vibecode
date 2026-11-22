# Plan: port src-tauri to Zig (zero-native)

Branch `spike/zero-native`. The renderer (`src/renderer`, TypeScript/React) stays as it is; the
backend moves to `native/src/commands`. Every step ends with `native/scripts/bridge-check.sh` (cases
added for each command) and, for UI steps, a look at the running window (`cd native && zig build run`).

## Where we are

- 28 of about 100 commands ported (see `native/README.md`), 48/48 bridge checks.
- The window opens. The page itself has not been checked since the Tauri imports remain.

## Steps

**1. Make the UI run without Tauri** (first, so the window shows the app)
- `Chrome.tsx`: replace `getCurrentWindow` (minimize, maximize, close, drag) with bridge calls. Until windowing exists these become no-ops or hide the custom title buttons.
- `api.ts`: `getCurrentWebview` (file drop) and `Channel` (terminal output) need steps 2 and 3.
- Check: the window shows the chat/editor UI with no errors in the page.

**2. Events and streams**
- Events: `commands.emit` already exists; verify it reaches the page (add a debug listener, look at the UI reacting).
- Watchers: fs (`fs_watch` → `fs:changed`), git (`git:changed`), keybindings (`keybindings:changed`), sessions (`sessions:changed`). Use inotify from the Zig std; emit on the UI thread (zero-native is single-threaded).
- Check: edit a file on disk and see the editor/explorer update.

**3. Terminals and ptyd** (the largest risk)
- Default: `ptyd` is a separate Zig binary that owns the PTYs (posix_openpt/forkpty) and outlives the app; the app attaches over a Unix socket. Replaces `pty.rs` (408 lines) and `ptyd.rs` (837 lines).
- Output streaming: replace the Tauri `Channel` with a per-terminal event (`pty:data:<id>`).
- Check: open a shell chat, type `ls`, close and reopen the app, and the session is still there.

**4. Windowing on Linux**
- Default: patch `node_modules/zero-native/src/platform/linux/gtk_host.c` through a local copy so the bridge can minimise, maximise, hide, resize and set the drop-down geometry. Badge via the desktop notification API if available.
- Check: each title-bar button and the drop-down mode work in the window.

**5. Browser tabs** (`browser.rs`, 999 lines, `webdata.rs`)
- Uses zero-native child webviews (`webview.create`, `setFrame`, `navigate`). Verify that child webviews with the bridge are supported on Linux (the README warns some backends do not support them).
- CDP/eval features (`web_eval`, key presses) need a WebKit-level path; decide per feature whether it is in scope.
- Check: open a web tab, navigate, back/forward, close.

**6. Remaining modules**
- `sessions` detail commands (images, context, tasks, subagents, changes).
- `webdata` (SQLite for Chrome import; vendor SQLite the same way as DuckDB).
- `plugins` (1213 lines: install, sidecar processes, registry).
- `mcp` (488 lines).
- `claude_usage` (HTTPS to the Anthropic API; use `std.http.Client`).
- `mssql` (1314 lines): it runs `mssql_bridge.ps1`, so it only works on Windows. Decision needed: port the bridge logic, or mark it Windows-only and leave it on the Tauri build.
- Tray, global shortcut, autostart: zero-native has tray and shortcut APIs; wire them up.

**7. Cutover**
- Remove `src-tauri/`, the Tauri npm packages and `vite` Tauri config, and rename the product build to the zero-native one.
- Keep the `master` branch on Tauri until the spike branch passes all checks.

## Decisions needed from you

1. Step 3: is `ptyd` as a separate Zig binary acceptable, or should the PTY stay in-process (losing "chat survives app close")?
2. Step 4: may we patch the zero-native GTK host in a local copy, or should the Linux window keep the native title bar (dropping custom buttons)?
3. Step 6: `mssql` on Linux: port it, or drop it from the Zig build?
4. Is there a deadline, or should each step be a separate goal?
