//! Every command the page may invoke. Names match the command names the renderer calls; a command is
//! added here once it is wired up.

const cmd = @import("root.zig");
const keybindings = @import("keybindings.zig");
const appcmds = @import("appcmds.zig");
const client_log = @import("client_log.zig");
const windowing = @import("windowing.zig");
const plugins = @import("plugins.zig");
const native_plugins = @import("native_plugins.zig");

pub const handlers = [_]cmd.Handler{
    cmd.handler("keybindings_path", keybindings.path),
    cmd.handler("keybindings_read", keybindings.read),
    cmd.handler("keybindings_write", keybindings.write),
    cmd.handler("client_log", client_log.log),
    cmd.handler("win_state", windowing.winState),
    cmd.handler("win_minimize", windowing.minimize),
    cmd.handler("win_toggle_maximize", windowing.toggleMaximize),
    cmd.handler("win_close", windowing.close),
    cmd.handler("win_hide", windowing.minimize),
    cmd.handler("win_set_mode", windowing.noop),
    cmd.handler("win_badge", windowing.noop),
    cmd.handler("win_drag", windowing.drag),
    cmd.handler("plugin_list", plugins.list),
    cmd.handler("plugin_start", plugins.start),
    cmd.handler("plugin_settings_file", plugins.settingsFile),
    cmd.handler("plugin_stop", plugins.stop),
    cmd.handler("plugin_restart", plugins.restart),
    cmd.handler("plugin_set", plugins.set),
    cmd.handler("plugin_logs", plugins.logsFor),
    cmd.handler("plugin_install", plugins.install),
    cmd.handler("plugin_uninstall", plugins.uninstall),
    cmd.handler("plugin_registry", plugins.registry),
    cmd.handler("plugin_registry_url", plugins.registryUrlCommand),
    cmd.handler("plugin_launch", plugins.launchCommand),
    cmd.handler("app_settings", appcmds.appSettings),
    cmd.handler("app_set_settings", appcmds.appSetSettings),
    cmd.handler("app_open_external", appcmds.appOpenExternal),
    cmd.handler("app_relaunch", appcmds.appRelaunch),
    cmd.handler("plugin_native_open", native_plugins.open),
    cmd.handler("plugin_native_frame", native_plugins.frame),
};

pub const names = [_][]const u8{
    "keybindings_path",
    "keybindings_read",
    "keybindings_write",
    "client_log",
    "win_state",
    "win_minimize",
    "win_toggle_maximize",
    "win_close",
    "win_hide",
    "win_set_mode",
    "win_badge",
    "win_drag",
    "plugin_list",
    "plugin_start",
    "plugin_settings_file",
    "plugin_stop",
    "plugin_restart",
    "plugin_set",
    "plugin_logs",
    "plugin_install",
    "plugin_uninstall",
    "plugin_registry",
    "plugin_registry_url",
    "plugin_launch",
    "app_settings",
    "app_set_settings",
    "app_open_external",
    "app_relaunch",
    "plugin_native_open",
    "plugin_native_frame",
};

pub const policy = cmd.policy(&names);
