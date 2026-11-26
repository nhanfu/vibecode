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

pub fn writeFile(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { path: []const u8, content: []const u8 }, a, invocation);
    std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = args.path, .data = args.content }) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, null);
}

const walk_skip = [_][]const u8{ ".git", "node_modules", "out", "dist", "build", ".next", ".venv", "venv", "__pycache__", "bin", "obj", ".vs" };
const max_listed_files: usize = 20_000;

const WalkEntry = struct { abs: []const u8, rel: []const u8 };

pub fn listFiles(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { root: []const u8 }, a, invocation);

    var files: std.ArrayList([]const u8) = .empty;
    var budget: usize = 2;
    var stack: std.ArrayList(WalkEntry) = .empty;
    try stack.append(a, .{ .abs = args.root, .rel = "" });

    while (stack.pop()) |dir_entry| {
        var dir = std.Io.Dir.openDirAbsolute(cmd.io, dir_entry.abs, .{ .iterate = true }) catch continue;
        defer dir.close(cmd.io);
        var subdirs: std.ArrayList(WalkEntry) = .empty;
        var it = dir.iterate();
        while (it.next(cmd.io) catch null) |entry| {
            if (files.items.len >= max_listed_files) return cmd.json(output, files.items);
            const rel = if (dir_entry.rel.len == 0)
                try a.dupe(u8, entry.name)
            else
                try std.fmt.allocPrint(a, "{s}/{s}", .{ dir_entry.rel, entry.name });
            if (entry.kind == .directory) {
                if (isWalkSkipped(entry.name)) continue;
                const abs = try std.fs.path.join(a, &.{ dir_entry.abs, entry.name });
                try subdirs.append(a, .{ .abs = abs, .rel = rel });
            } else {
                budget += rel.len + 3;
                if (budget > output.len - 64) return cmd.json(output, files.items);
                try files.append(a, rel);
            }
        }
        var index = subdirs.items.len;
        while (index > 0) {
            index -= 1;
            try stack.append(a, subdirs.items[index]);
        }
    }
    return cmd.json(output, files.items);
}

fn isWalkSkipped(name: []const u8) bool {
    for (walk_skip) |skipped| if (std.mem.eql(u8, skipped, name)) return true;
    return false;
}

pub fn openPath(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { path: []const u8 }, a, invocation);
    const result = std.process.run(cmd.gpa, cmd.io, .{ .argv = &.{ "xdg-open", args.path }, .timeout = cmd.helper_timeout }) catch |err| switch (err) {
        error.Timeout => return cmd.json(output, ""),
        else => return cmd.json(output, @errorName(err)),
    };
    defer cmd.gpa.free(result.stdout);
    defer cmd.gpa.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code != 0) return cmd.json(output, std.mem.trim(u8, result.stderr, " \r\n\t")),
        else => {},
    }
    return cmd.json(output, "");
}

const reveal_timeout: std.Io.Timeout = .{ .duration = .{ .raw = std.Io.Duration.fromMilliseconds(5000), .clock = .awake } };

fn fileUri(a: std.mem.Allocator, path: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, "file://");
    for (path) |ch| {
        if (std.ascii.isAlphanumeric(ch) or ch == '/' or ch == '.' or ch == '_' or ch == '-' or ch == '~') {
            try out.append(a, ch);
        } else {
            try out.print(a, "%{X:0>2}", .{ch});
        }
    }
    return out.items;
}

pub fn reveal(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { path: []const u8 }, a, invocation);
    const uri = try fileUri(a, args.path);
    const quoted = try std.fmt.allocPrint(a, "['{s}']", .{uri});

    const shown = std.process.run(cmd.gpa, cmd.io, .{
        .argv = &.{ "gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", quoted, "''" },
        .timeout = reveal_timeout,
    }) catch null;
    if (shown) |result| {
        defer cmd.gpa.free(result.stdout);
        defer cmd.gpa.free(result.stderr);
        switch (result.term) {
            .exited => |code| if (code == 0) return cmd.json(output, null),
            else => {},
        }
    }

    const folder = std.fs.path.dirname(args.path) orelse args.path;
    const opened = std.process.run(cmd.gpa, cmd.io, .{ .argv = &.{ "xdg-open", folder }, .timeout = cmd.helper_timeout }) catch |err| switch (err) {
        error.Timeout => return cmd.json(output, null),
        else => return cmd.fail(output, @errorName(err)),
    };
    cmd.gpa.free(opened.stdout);
    cmd.gpa.free(opened.stderr);
    return cmd.json(output, null);
}
