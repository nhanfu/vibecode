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
