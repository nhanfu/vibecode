//! File-system commands the Explorer and editor use. Port of src-tauri/src/fsx.rs; the write, watch
//! and reveal commands are not ported yet.

const std = @import("std");
const cmd = @import("root.zig");

const hidden = [_][]const u8{ ".git", "node_modules", ".DS_Store", "Thumbs.db" };
const max_text_bytes: u64 = 8 * 1024 * 1024;

const DirEntry = struct {
    path: []const u8,
    name: []const u8,
    isDir: bool,
};

fn isHidden(name: []const u8) bool {
    for (hidden) |h| if (std.mem.eql(u8, h, name)) return true;
    return false;
}

fn lessThan(_: void, a: DirEntry, b: DirEntry) bool {
    if (a.isDir != b.isDir) return a.isDir;
    return std.ascii.lessThanIgnoreCase(a.name, b.name);
}

const Args = struct { dir: []const u8 };

/// Entries of a folder, without the hidden ones: folders first, then by name (case-insensitive).
pub fn readDir(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(Args, a, invocation);

    var dir = try std.Io.Dir.openDirAbsolute(cmd.io, args.dir, .{ .iterate = true });
    defer dir.close(cmd.io);

    var entries: std.ArrayList(DirEntry) = .empty;
    defer {
        for (entries.items) |e| {
            cmd.gpa.free(e.path);
            cmd.gpa.free(e.name);
        }
        entries.deinit(cmd.gpa);
    }

    var it = dir.iterate();
    while (try it.next(cmd.io)) |entry| {
        if (isHidden(entry.name)) continue;
        const name = try cmd.gpa.dupe(u8, entry.name);
        errdefer cmd.gpa.free(name);
        const path = try std.fs.path.join(cmd.gpa, &.{ args.dir, entry.name });
        errdefer cmd.gpa.free(path);
        try entries.append(cmd.gpa, .{ .path = path, .name = name, .isDir = entry.kind == .directory });
    }
    std.mem.sort(DirEntry, entries.items, {}, lessThan);
    return cmd.json(output, entries.items);
}

const FileContent = struct {
    content: []const u8,
    binary: bool,
    tooLarge: bool,
};

/// A file's text. Large files and binary files (a NUL in the first 8000 bytes) come back empty, with a flag.
pub fn readFile(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { path: []const u8 }, a, invocation);

    const stat = try std.Io.Dir.cwd().statFile(cmd.io, args.path, .{});
    if (stat.size > max_text_bytes) {
        return cmd.json(output, FileContent{ .content = "", .binary = false, .tooLarge = true });
    }
    const bytes = try std.Io.Dir.cwd().readFileAlloc(cmd.io, args.path, cmd.gpa, .limited(max_text_bytes));
    defer cmd.gpa.free(bytes);
    if (std.mem.indexOfScalar(u8, bytes[0..@min(bytes.len, 8000)], 0) != null) {
        return cmd.json(output, FileContent{ .content = "", .binary = true, .tooLarge = false });
    }
    const text = try cmd.lossy(cmd.gpa, bytes);
    defer cmd.gpa.free(text);
    return cmd.json(output, FileContent{ .content = text, .binary = false, .tooLarge = false });
}
