//! Small app-level commands: settings, opening a link in the desktop's browser, relaunching the app.

const std = @import("std");
const cmd = @import("root.zig");
const settings = @import("settings.zig");

// ---------------- settings ----------------

pub fn appSettings(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, settings.get());
}

const allowed_settings = [_][]const u8{ "theme", "dropOpacity", "dropHeight", "hideOnBlur", "seeThrough" };

/// `{ patch }`: only the page-level settings may change through here.
pub fn appSetSettings(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { patch: std.json.Value }, a, invocation);
    var clean = std.json.ObjectMap.empty;
    switch (args.patch) {
        .object => |object| for (object.keys(), object.values()) |key, value| {
            for (allowed_settings) |allowed| {
                if (std.mem.eql(u8, key, allowed)) try clean.put(a, key, value);
            }
        },
        else => return cmd.fail(output, "patch must be an object"),
    }
    const next = settings.update(clean) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, next);
}

/// `{ url }`: opens an http(s) link in the desktop's browser.
pub fn appOpenExternal(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { url: []const u8 }, a, invocation);
    if (std.mem.startsWith(u8, args.url, "http://") or std.mem.startsWith(u8, args.url, "https://")) {
        const result = std.process.run(cmd.gpa, cmd.io, .{ .argv = &.{ "xdg-open", args.url }, .timeout = cmd.helper_timeout }) catch |err| return cmd.fail(output, @errorName(err));
        cmd.gpa.free(result.stdout);
        cmd.gpa.free(result.stderr);
    }
    return cmd.json(output, null);
}

pub fn appRelaunch(_: cmd.Invocation, output: []u8) ![]const u8 {
    if (std.c.getenv("ZERO_NATIVE_FRONTEND_URL") != null) return cmd.json(output, false);
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const exe = std.process.executablePathAlloc(cmd.io, a) catch |err| return cmd.fail(output, @errorName(err));
    _ = std.process.spawn(cmd.io, .{ .argv = &.{ "/bin/sh", "-c", "sleep 1; exec \"$0\"", exe } }) catch |err| return cmd.fail(output, @errorName(err));
    std.process.exit(0);
}
