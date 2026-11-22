//! Every command the page may invoke. Names match the Tauri command names so the renderer's calls
//! stay the same; a command is added here once its port is verified (see native/README.md).

const cmd = @import("root.zig");
const keybindings = @import("keybindings.zig");
const fsx = @import("fsx.zig");
const git = @import("git.zig");

pub const handlers = [_]cmd.Handler{
    cmd.handler("keybindings_path", keybindings.path),
    cmd.handler("keybindings_read", keybindings.read),
    cmd.handler("fs_read_dir", fsx.readDir),
    cmd.handler("fs_read_file", fsx.readFile),
    cmd.handler("git_state", git.state),
    cmd.handler("git_original", git.original),
    cmd.handler("git_init", git.init),
    cmd.handler("git_show", git.show),
    cmd.handler("git_snapshot", git.snapshot),
    cmd.handler("git_log", git.log),
    cmd.handler("git_commit_files", git.commitFiles),
    cmd.handler("git_branches", git.branches),
    cmd.handler("git_checkout", git.checkout),
};

pub const names = [_][]const u8{
    "keybindings_path",
    "keybindings_read",
    "fs_read_dir",
    "fs_read_file",
    "git_state",
    "git_original",
    "git_init",
    "git_show",
    "git_snapshot",
    "git_log",
    "git_commit_files",
    "git_branches",
    "git_checkout",
};

pub const policy = cmd.policy(&names);
