const std = @import("std");
const zn = @import("zero-native");
const cmd = @import("root.zig");
const settings = @import("settings.zig");

extern "c" fn zero_native_gtk_window_minimize(host: *anyopaque) c_int;
extern "c" fn zero_native_gtk_window_toggle_maximize(host: *anyopaque) c_int;
extern "c" fn zero_native_gtk_window_is_maximized(host: *anyopaque) c_int;
extern "c" fn zero_native_gtk_window_close(host: *anyopaque) c_int;
extern "c" fn zero_native_gtk_window_begin_move(host: *anyopaque, button: c_int, x: f64, y: f64) c_int;

fn host() ?*anyopaque {
    return zn.platform.gtk_host.web_host;
}

pub fn winState(_: cmd.Invocation, output: []u8) ![]const u8 {
    const s = settings.get();
    const maximized = if (host()) |h| zero_native_gtk_window_is_maximized(h) != 0 else false;
    return cmd.json(output, .{
        .mode = s.mode,
        .maximized = maximized,
        .hotkey = s.hotkey,
        .hotkeyOk = false,
    });
}

pub fn minimize(_: cmd.Invocation, output: []u8) ![]const u8 {
    if (host()) |h| _ = zero_native_gtk_window_minimize(h);
    return cmd.json(output, null);
}

pub fn toggleMaximize(_: cmd.Invocation, output: []u8) ![]const u8 {
    if (host()) |h| _ = zero_native_gtk_window_toggle_maximize(h);
    return cmd.json(output, null);
}

pub fn close(_: cmd.Invocation, output: []u8) ![]const u8 {
    if (host()) |h| _ = zero_native_gtk_window_close(h);
    return cmd.json(output, null);
}

pub fn drag(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { button: i32 = 1, x: f64, y: f64 }, arena.allocator(), invocation);
    if (host()) |h| _ = zero_native_gtk_window_begin_move(h, args.button, args.x, args.y);
    return cmd.json(output, null);
}

pub fn noop(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, null);
}
