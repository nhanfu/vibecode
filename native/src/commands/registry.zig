//! Every command the page may invoke. Names match the Tauri command names so the renderer's calls
//! stay the same; a command is added here once its port is verified (see native/README.md).

const cmd = @import("root.zig");
const keybindings = @import("keybindings.zig");
const fsx = @import("fsx.zig");
const git = @import("git.zig");
const userdb = @import("userdb.zig");
const appcmds = @import("appcmds.zig");
const sessions = @import("sessions.zig");
const client_log = @import("client_log.zig");
const detect = @import("detect.zig");
const windowing = @import("windowing.zig");
const watch = @import("watch.zig");
const pty = @import("pty.zig");

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
    cmd.handler("userdb_snapshot", userdb.snapshot),
    cmd.handler("userdb_prefs_write", userdb.prefsWrite),
    cmd.handler("userdb_save", userdb.save),
    cmd.handler("sessions_list", sessions.list),
    cmd.handler("client_log", client_log.log),
    cmd.handler("claude_detect", detect.claudeDetect),
    cmd.handler("win_state", windowing.winState),
    cmd.handler("fs_watch", watch.fsWatch),
    cmd.handler("pty_spawn", pty.spawn),
    cmd.handler("pty_write", pty.write),
    cmd.handler("pty_resize", pty.resize),
    cmd.handler("pty_kill", pty.kill),
    cmd.handler("pty_page_reset", pty.pageReset),
    cmd.handler("pty_list", pty.list),
    cmd.handler("pty_visible", pty.visible),
    cmd.handler("claude_get_project_bypass", appcmds.getProjectBypass),
    cmd.handler("claude_set_project_bypass", appcmds.setProjectBypass),
    cmd.handler("sys_memory", appcmds.sysMemory),
    cmd.handler("app_settings", appcmds.appSettings),
    cmd.handler("app_remember_folder", appcmds.appRememberFolder),
    cmd.handler("app_set_settings", appcmds.appSetSettings),
    cmd.handler("app_file_info", appcmds.appFileInfo),
    cmd.handler("app_open_external", appcmds.appOpenExternal),
    cmd.handler("app_save_image", appcmds.appSaveImage),
    cmd.handler("app_clipboard_files", appcmds.appClipboardFiles),
    cmd.handler("app_clipboard_image", appcmds.appClipboardImage),
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
    "userdb_snapshot",
    "userdb_prefs_write",
    "userdb_save",
    "sessions_list",
    "client_log",
    "claude_detect",
    "win_state",
    "fs_watch",
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_page_reset",
    "pty_list",
    "pty_visible",
    "claude_get_project_bypass",
    "claude_set_project_bypass",
    "sys_memory",
    "app_settings",
    "app_remember_folder",
    "app_set_settings",
    "app_file_info",
    "app_open_external",
    "app_save_image",
    "app_clipboard_files",
    "app_clipboard_image",
};

pub const policy = cmd.policy(&names);
