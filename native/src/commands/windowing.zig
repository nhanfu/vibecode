//! Window state for the title bar. Port of win_state in src-tauri/src/windowing.rs. On Linux the native
//! window is not controlled yet (native/PLAN.md, step 4): `maximized` stays false and `hotkeyOk` false
//! until the global shortcut is wired.

const std = @import("std");
const cmd = @import("root.zig");
const settings = @import("settings.zig");

pub fn winState(_: cmd.Invocation, output: []u8) ![]const u8 {
    const s = settings.get();
    return cmd.json(output, .{
        .mode = s.mode,
        .maximized = false,
        .hotkey = s.hotkey,
        .hotkeyOk = false,
    });
}
