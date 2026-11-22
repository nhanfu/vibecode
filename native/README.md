# native/: the zero-native shell and command layer

This folder is the Zig side of the spike on branch `spike/zero-native`. It replaces `src-tauri/`
one command at a time; the renderer in `src/renderer` is shared with the Tauri build.

## Layout

- `src/main.zig`: entry point; wires the command registry into the zero-native runner.
- `src/commands/root.zig`: shared helpers (handler wrapper, argument parsing, JSON output, user data folder).
- `src/commands/registry.zig`: every command the page may call, with its policy. Add a command here after porting it.
- `src/commands/*.zig`: one file per Tauri module (`keybindings.rs`, `fsx.rs`, ...).
- `scripts/bridge-check.sh`: functional check. Runs the built app and sends each case in
  `scripts/bridge-cases.tsv` through zero-native's automation channel.

## Porting a command

1. Port the Rust function into `src/commands/<module>.zig` with the same name and payload keys.
2. Register it in `registry.zig` (handler and name).
3. Add a case to `scripts/bridge-cases.tsv`, then run:

   ```bash
   cd native && zig build -Dautomation=true && scripts/bridge-check.sh
   ```

4. Only when the case passes, remove the Rust version from `src-tauri/`.

## Known gaps

- Errors reach the page as `handler_failed` with the Zig error name, not the Tauri error text.
- Events (`emit`, `listen`) and the `Channel` used for terminal output are not ported yet.
- The page itself is not checked by `bridge-check.sh`: its output is not visible to automation.

## Status

Ported and checked by `scripts/bridge-check.sh` (48 cases):

- sessions (list only): `sessions_list`
- keybindings: `keybindings_path`, `keybindings_read`
- files: `fs_read_dir`, `fs_read_file`
- git: `git_state`, `git_original`, `git_init`, `git_show`, `git_snapshot`, `git_log`, `git_commit_files`, `git_branches`, `git_checkout`
- user database (DuckDB, vendored): `userdb_snapshot`, `userdb_prefs_write`, `userdb_save`
- app: `app_settings`, `app_set_settings`, `app_remember_folder`, `app_file_info`, `app_open_external`, `app_save_image`, `app_clipboard_files`, `app_clipboard_image`, `sys_memory`, `claude_get_project_bypass`, `claude_set_project_bypass`

Not ported yet (still in `src-tauri/`):

- events to the page (`emit` / `listen`), and the streaming channel used for terminal output
- windowing: minimise, maximise, hide, drop-down mode, badge (needs window control that zero-native does not expose yet)
- pickers (`app_pick_folder`, `app_pick_files`: use the built-in dialogs), `app_relaunch`, `app_clear_browser_cache`
- terminals and the ptyd daemon (`pty.rs`, `ptyd.rs`)
- browser tabs (`browser.rs`), web data and Chrome import (`webdata.rs`), sessions (`sessions.rs`)
- plugins (`plugins.rs`), SQL Server (`mssql.rs`), Claude usage (`claude_usage`), MCP (`mcp.rs`)
- global shortcut, tray, autostart (zero-native has shortcut and tray APIs, not yet wired)
