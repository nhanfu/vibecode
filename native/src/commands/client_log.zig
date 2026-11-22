//! The page reports its own errors here, so a blank window can be diagnosed from the terminal.
//! The message goes to stderr as is; nothing is stored.

const std = @import("std");
const cmd = @import("root.zig");

pub fn log(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { message: []const u8 }, a, invocation);
    std.debug.print("[page] {s}\n", .{args.message});
    return cmd.json(output, null);
}
