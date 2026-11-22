//! Every command the page may invoke. Names match the Tauri command names so the renderer's calls
//! stay the same; a command is added here once its port is verified (see native/README.md).

const cmd = @import("root.zig");
const keybindings = @import("keybindings.zig");

pub const handlers = [_]cmd.Handler{
    cmd.handler("keybindings_path", keybindings.path),
    cmd.handler("keybindings_read", keybindings.read),
};

pub const names = [_][]const u8{
    "keybindings_path",
    "keybindings_read",
};

pub const policy = cmd.policy(&names);
