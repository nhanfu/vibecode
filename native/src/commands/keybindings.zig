//! The user's keyboard shortcuts file, `<userData>/keybindings.json` (VS Code format).
//! Port of src-tauri/src/keybindings.rs; the watcher that emits "keybindings:changed" is not ported yet.

const std = @import("std");
const cmd = @import("root.zig");

const file_name = "keybindings.json";

fn filePath(buffer: []u8) ![]const u8 {
    var dir_buffer: [4096]u8 = undefined;
    const dir = try cmd.userData(&dir_buffer);
    return std.fmt.bufPrint(buffer, "{s}/{s}", .{ dir, file_name });
}

pub fn path(_: cmd.Invocation, output: []u8) ![]const u8 {
    var buffer: [4096]u8 = undefined;
    return cmd.json(output, try filePath(&buffer));
}

pub fn read(_: cmd.Invocation, output: []u8) ![]const u8 {
    var buffer: [4096]u8 = undefined;
    const file = try filePath(&buffer);
    const text = std.Io.Dir.cwd().readFileAlloc(cmd.io, file, cmd.gpa, .limited(8 * 1024 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return cmd.json(output, @as(?[]const u8, null)),
        else => return err,
    };
    defer cmd.gpa.free(text);
    return cmd.json(output, @as(?[]const u8, text));
}

/// `{ text }`: writes the whole keybindings.json (the editor saves the rules it changed).
pub fn write(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { text: []const u8 }, a, invocation);
    var buffer: [4096]u8 = undefined;
    const file = try filePath(&buffer);
    std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = args.text }) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, null);
}
