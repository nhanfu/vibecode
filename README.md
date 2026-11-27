# VIBE CODE

Desktop workspace for **Claude Code**: several parallel chats, a Monaco editor (the VS Code editor core), a live Git *Changes* panel with diff view, and an integrated terminal.

![VIBE CODE demo: open a project, go to file, ask Claude for a change, review the diff, run git in the terminal, switch theme](docs/demo.gif)

Stack: Tauri 2 (Rust backend, system WebView2 / WKWebView) · React · TypeScript · Vite · Monaco · xterm.js (WebGL) · portable-pty (ConPTY)

## Run

```bash
npm install
npm run dev        # tauri dev: Vite with hot reload + the Rust backend
npm run build      # release build + installer in src-tauri/target/release/bundle/
```

Building needs Node 24+, Rust (stable, MSVC toolchain on Windows) and, on Windows, the
Visual Studio C++ Build Tools. Running needs Git and the `claude` CLI on PATH
(`npm install -g @anthropic-ai/claude-code`). The app itself has no Node runtime.

## Shortcuts

All commands with their keys are listed in the command palette (**Ctrl+Shift+P** or **F1**).
Bindings follow VS Code / Windows Terminal. Keys that mean something in a terminal (Ctrl+W, Ctrl+J,
Ctrl+O, Ctrl+L, Ctrl+T…, used by readline and Claude Code) go to the terminal while it has the
cursor. They can all be changed in `keybindings.json` (VS Code's format, with `when` clauses):
palette → *Open keyboard shortcuts*.

| Keys | Action |
|---|---|
| Alt+` (global) | Show / hide VIBE CODE (drop-down slides over any app) |
| Ctrl+Shift+P / F1 | Command palette |
| Ctrl+P | Go to file (`@` symbol, `:` line, `>` commands) |
| Ctrl+Shift+O / Ctrl+G | Go to symbol / line in the open file |
| Ctrl+Shift+N | New chat |
| Alt+1…9 · Ctrl+Alt+← / → | Switch chat · previous / next chat |
| Ctrl+Shift+L | Put the cursor in the open chat |
| Ctrl+B · Ctrl+E · Ctrl+Shift+W · Ctrl+Shift+A (Ctrl+1, 2, 4) | Show / hide Project · Source code · Web · Agent (the chat) |
| Ctrl+Shift+E / G / C | Explorer / Changes / Chats |
| Ctrl+` · Ctrl+J · Ctrl+Shift+` | Toggle terminal · toggle panel · new terminal |
| Ctrl+S · Ctrl+W (Ctrl+F4) · Ctrl+Shift+T | Save · close editor tab · reopen closed tab |
| Ctrl+Tab / Ctrl+Shift+Tab (Ctrl+PgDn / PgUp) | Next / previous editor tab |
| Ctrl+O | Open folder |
| Ctrl+C (with selection) / Ctrl+Shift+C · Ctrl+V | Copy / paste in a terminal |
| Ctrl+= / Ctrl+− / Ctrl+0 | Terminal font size |
| Shift+Enter (in chat) | Newline in Claude prompt |

F5 / Ctrl+R never reload the app window (that would blank every chat). Ctrl+Shift+R reloads the app: the chats come back by resuming their sessions, with a loading line while they start.

## Drop-down (Guake) mode

Click **Guake** in the title bar (or use the tray icon menu). VIBE CODE then lives at the top edge of the screen under the mouse: the global hotkey slides it down over whatever app you're in and back up again. The tray menu sets height, opacity and "hide when focus is lost". Dragging the bottom edge changes the height. The hotkey is `hotkey` in `%APPDATA%\TINJS Studio\settings.json` (F12 can't be used: Windows reserves it for debuggers).

## The stack: Project, Source code, Web, Agent

**Project** (chats and folders), **Source code**, **Web** and **Agent** (the chat with
the agent you are talking to, named after it: "Claude Code", "Codex"…) are drop-downs in the title
bar. Each one floats: hovering its button shows it, a click (or its key) keeps it open, a second click
or a click elsewhere closes it.

**Double-click** a button (or right-click it → Pin) to pin it: pinned drop-downs sit side
by side in a horizontal stack and stay there; the last one (the chat, when pinned) takes the room
left. Double-click again to float it again. Agent starts pinned. **Drag the buttons** left and right
to reorder the stack (or right-click → Move left / right); the order and the pins are remembered.

On the left of the chat, the Agent drop-down lists every coding agent (installed or not, with its
install command; the star marks the one a plain New chat uses; `+` starts a chat with it) and the
chats running now by agent, to switch to, restart or close. Hide it with its button; a thin rail
brings it back. Drag a drop-down's right edge to resize it.

## Claude history

The Chats sidebar lists every project and conversation from `~/.claude/projects`, the store shared by the Claude desktop app, the CLI and the IDE extensions. It updates live. Clicking a conversation resumes it (`claude --resume <id>`) in its own folder. New chats are started with `--session-id`, so they show up in that same history.

## Layout

- `src-tauri/src` – Rust backend: terminals (`pty.rs`), files + watcher, git, Claude's session
  store, the built-in browser (`browser.rs`, native
  WebView2 / WebKitGTK tabs that sleep when hidden), the MCP server Claude's tools talk to (`mcp.rs`), window /
  tray / drop-down mode (`windowing.rs`)
- `src/renderer/src/api.ts` – `window.api`: the page's bridge to the Rust commands and events
- `src/renderer/src` – UI (`components/`), state (`store.ts`, `actions.ts`), terminals, Monaco setup

`STUDIO_USER_DATA=<folder>` runs with a separate profile (settings, logins).
