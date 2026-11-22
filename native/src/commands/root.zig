const std = @import("std");
const zero_native = @import("zero-native");

pub const Invocation = zero_native.bridge.Invocation;
pub const Handler = zero_native.BridgeHandler;
pub const Policy = zero_native.BridgeCommandPolicy;

pub var io: std.Io = undefined;
pub var gpa: std.mem.Allocator = undefined;

pub const origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

var context_marker: u8 = 0;

pub fn handler(comptime name: []const u8, comptime func: fn (Invocation, []u8) anyerror![]const u8) Handler {
    return .{
        .name = name,
        .context = &context_marker,
        .invoke_fn = struct {
            fn call(context: *anyopaque, invocation: Invocation, output: []u8) anyerror![]const u8 {
                _ = context;
                return func(invocation, output);
            }
        }.call,
    };
}

pub fn policy(comptime names: []const []const u8) []const Policy {
    comptime var list: [names.len]Policy = undefined;
    inline for (names, 0..) |name, i| list[i] = .{ .name = name, .origins = &origins };
    const frozen = list;
    return &frozen;
}

/// Decodes the request payload into `T`. Strings point into `scratch`, so the caller keeps it alive.
pub fn args(comptime T: type, invocation: Invocation, scratch: []u8) !T {
    var fba = std.heap.FixedBufferAllocator.init(scratch);
    return std.json.parseFromSliceLeaky(T, fba.allocator(), invocation.request.payload, .{
        .ignore_unknown_fields = true,
    });
}

/// Writes `value` as the JSON result of a command.
pub fn json(output: []u8, value: anytype) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try std.json.Stringify.value(value, .{}, &writer);
    return writer.buffered();
}

/// `<config>/TINJS Studio`, the folder the Tauri build used: `$STUDIO_USER_DATA`, else `$XDG_CONFIG_HOME` or `~/.config`.
pub fn userData(buffer: []u8) ![]const u8 {
    if (std.c.getenv("STUDIO_USER_DATA")) |raw| return std.mem.span(raw);
    const base = if (std.c.getenv("XDG_CONFIG_HOME")) |raw|
        std.mem.span(raw)
    else blk: {
        const home = std.mem.span(std.c.getenv("HOME") orelse return error.NoHome);
        break :blk try std.fmt.bufPrint(buffer[buffer.len / 2 ..], "{s}/.config", .{home});
    };
    return std.fmt.bufPrint(buffer[0 .. buffer.len / 2], "{s}/TINJS Studio", .{base});
}
