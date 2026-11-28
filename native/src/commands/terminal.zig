//! The native terminal pane: a command on a PTY, drawn by a GTK widget on the app window (src/terminal/term_gtk.c).
//! The page opens it once with the command to run, then places it over its panel with `terminal_frame`.

const std = @import("std");
const cmd = @import("root.zig");

comptime {
    // the Zig part of the terminal (PTY, libghostty-vt, snapshot for the drawing); term_gtk.c calls it
    _ = @import("../terminal/termcore.zig");
}

extern fn zt_open(argv: [*c][*c]u8) c_int;
extern fn zt_set_frame(x: f64, y: f64, width: f64, height: f64, visible: c_int) void;

/// The user's login shell ($SHELL), or /bin/sh.
fn shellPath() []const u8 {
    return if (std.c.getenv("SHELL")) |s| std.mem.span(s) else "/bin/sh";
}

/// `{ command: string[] }`: creates the pane and starts the command in it (the shell when it is empty). A second call keeps the first pane.
pub fn open(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { command: []const []const u8 }, a, invocation);
    // no command: the user's shell, as in any terminal
    const command: []const []const u8 = if (args.command.len > 0) args.command else &.{shellPath()};

    const argv = try a.alloc([*c]u8, command.len + 1);
    for (command, 0..) |part, i| argv[i] = (try a.dupeZ(u8, part)).ptr;
    argv[command.len] = null;
    if (zt_open(argv.ptr) != 0) return cmd.fail(output, "the terminal could not be created");
    return cmd.json(output, true);
}

/// `{ x, y, width, height, visible }`: where the pane sits in the window (CSS pixels); hidden when not visible.
pub fn frame(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { x: f64, y: f64, width: f64, height: f64, visible: bool }, arena.allocator(), invocation);
    zt_set_frame(args.x, args.y, args.width, args.height, @intFromBool(args.visible));
    return cmd.json(output, null);
}
