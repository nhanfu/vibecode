//! Small app-level commands: settings, attachments, the project's Claude Code bypass switch, clipboard
//! pictures. Port of src-tauri/src/appcmds.rs. Pickers and the relaunch are not here yet (see native/README.md).

const std = @import("std");
const cmd = @import("root.zig");
const settings = @import("settings.zig");

const Allocator = std.mem.Allocator;

// ---------------- Claude Code's per-project bypass ----------------

/// `<folder>/.claude/settings.local.json` as an object; an empty object when it is missing or blank,
/// and an error when it is present but not JSON (so a write never wipes the user's settings).
fn readProjectLocal(a: Allocator, folder: []const u8) !std.json.ObjectMap {
    const path = try std.fmt.allocPrint(a, "{s}/.claude/settings.local.json", .{folder});
    const raw = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(4 * 1024 * 1024)) catch return std.json.ObjectMap.empty;
    if (std.mem.trim(u8, raw, " \r\n\t").len == 0) return std.json.ObjectMap.empty;
    const value = try std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{});
    return switch (value) {
        .object => |object| object,
        else => error.NotAnObject,
    };
}

fn isBypass(value: ?std.json.Value) bool {
    const v = value orelse return false;
    return switch (v) {
        .string => |s| std.mem.eql(u8, s, "bypassPermissions"),
        else => false,
    };
}

pub fn getProjectBypass(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { folder: []const u8 }, a, invocation);

    const local = readProjectLocal(a, args.folder) catch std.json.ObjectMap.empty;
    const permissions = local.get("permissions") orelse return cmd.json(output, false);
    const perms = switch (permissions) {
        .object => |o| o,
        else => return cmd.json(output, false),
    };
    return cmd.json(output, isBypass(perms.get("defaultMode")));
}

pub fn setProjectBypass(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { folder: []const u8, on: bool }, a, invocation);

    var local = readProjectLocal(a, args.folder) catch |err| return cmd.fail(output, @errorName(err));
    var perms: std.json.ObjectMap = if (local.get("permissions")) |p| switch (p) {
        .object => |o| o,
        else => std.json.ObjectMap.empty,
    } else std.json.ObjectMap.empty;
    if (args.on) {
        try perms.put(a, "defaultMode", .{ .string = "bypassPermissions" });
    } else if (isBypass(perms.get("defaultMode"))) {
        _ = perms.swapRemove("defaultMode");
    }
    if (perms.count() == 0) {
        _ = local.swapRemove("permissions");
    } else {
        try local.put(a, "permissions", .{ .object = perms });
    }

    const dir = try std.fmt.allocPrint(a, "{s}/.claude", .{args.folder});
    try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
    const text = try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = local }, .{ .whitespace = .indent_2 });
    const file = try std.fmt.allocPrint(a, "{s}/settings.local.json", .{dir});
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = try std.fmt.allocPrint(a, "{s}\n", .{text}) });
    return cmd.json(output, args.on);
}

// ---------------- system memory ----------------

/// Physical RAM in use across the machine. Only Windows reports it in the Tauri build; elsewhere null.
pub fn sysMemory(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, @as(?u8, null));
}

// ---------------- settings ----------------

pub fn appSettings(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, settings.get());
}

pub fn appRememberFolder(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { folder: []const u8 }, a, invocation);
    const next = settings.rememberFolder(args.folder) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, next);
}

const allowed_settings = [_][]const u8{ "theme", "dropOpacity", "dropHeight", "hideOnBlur", "model", "effort", "permissionMode", "seeThrough" };

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

// ---------------- attachments ----------------

const FileInfo = struct {
    path: []const u8,
    size: i64,
    dir: bool,
    preview: ?[]const u8 = null,
};

const max_preview_bytes: u64 = 15 * 1024 * 1024;

fn imageMime(path: []const u8) ?[]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return null;
    const ext = path[dot + 1 ..];
    const table = [_]struct { ext: []const u8, mime: []const u8 }{
        .{ .ext = "png", .mime = "image/png" },
        .{ .ext = "jpg", .mime = "image/jpeg" },
        .{ .ext = "jpeg", .mime = "image/jpeg" },
        .{ .ext = "gif", .mime = "image/gif" },
        .{ .ext = "webp", .mime = "image/webp" },
        .{ .ext = "bmp", .mime = "image/bmp" },
        .{ .ext = "svg", .mime = "image/svg+xml" },
        .{ .ext = "ico", .mime = "image/x-icon" },
        .{ .ext = "avif", .mime = "image/avif" },
    };
    for (table) |entry| {
        if (std.ascii.eqlIgnoreCase(ext, entry.ext)) return entry.mime;
    }
    return null;
}

/// `{ paths }`: size, folder?, and an image's picture (≤ 15 MB) as a data: URL. A missing path has size -1.
pub fn appFileInfo(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { paths: []const []const u8 }, a, invocation);

    var infos: std.ArrayList(FileInfo) = .empty;
    for (args.paths) |path| {
        const stat = std.Io.Dir.cwd().statFile(cmd.io, path, .{}) catch {
            try infos.append(a, .{ .path = path, .size = -1, .dir = false });
            continue;
        };
        const is_file = stat.kind == .file;
        const is_dir = stat.kind == .directory;
        var preview: ?[]const u8 = null;
        if (is_file and stat.size <= max_preview_bytes) {
            if (imageMime(path)) |mime| {
                if (std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(max_preview_bytes))) |bytes| {
                    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
                    _ = std.base64.standard.Encoder.encode(encoded, bytes);
                    preview = try std.fmt.allocPrint(a, "data:{s};base64,{s}", .{ mime, encoded });
                } else |_| {}
            }
        }
        try infos.append(a, .{
            .path = path,
            .size = if (is_file) @intCast(stat.size) else -1,
            .dir = is_dir,
            .preview = preview,
        });
    }
    return cmd.json(output, infos.items);
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

/// Pasted or dropped image: `{ ext, data }` with the bytes as base64, saved under the temp folder.
pub fn appSaveImage(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const payload = try a.alloc(u8, invocation.request.payload.len);
    _ = payload;
    const args = try cmd.args(struct { ext: []const u8, data: []const u8 }, a, invocation);

    const ext = if (args.ext.len > 0 and args.ext.len <= 5 and isAlnum(args.ext)) args.ext else "png";
    const bytes = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(args.data));
    try std.base64.standard.Decoder.decode(bytes, args.data);

    const dir = try std.fmt.allocPrint(a, "{s}/tinjs-paste", .{cmd.tempDir()});
    try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
    const file = try std.fmt.allocPrint(a, "{s}/image-{d}.{s}", .{ dir, cmd.nowMs(), ext });
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = bytes });
    return cmd.json(output, file);
}

fn isAlnum(text: []const u8) bool {
    for (text) |c| {
        if (!std.ascii.isAlphanumeric(c)) return false;
    }
    return true;
}

/// Files copied in Explorer are a Windows clipboard format; the Linux build reports none.
pub fn appClipboardFiles(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, @as([]const []const u8, &.{}));
}

/// A picture on the clipboard → a temp PNG, read through the desktop's clipboard tool.
pub fn appClipboardImage(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const bytes = clipboardImageBytes(a) orelse return cmd.json(output, @as(?[]const u8, null));
    if (bytes.len == 0) return cmd.json(output, @as(?[]const u8, null));
    const dir = try std.fmt.allocPrint(a, "{s}/tinjs-paste", .{cmd.tempDir()});
    try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
    const file = try std.fmt.allocPrint(a, "{s}/image-{d}.png", .{ dir, cmd.nowMs() });
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = bytes });
    return cmd.json(output, @as(?[]const u8, file));
}

fn clipboardImageBytes(a: Allocator) ?[]const u8 {
    if (std.c.getenv("WAYLAND_DISPLAY") != null) {
        const types = std.process.run(a, cmd.io, .{ .argv = &.{ "wl-paste", "--list-types" }, .timeout = cmd.helper_timeout }) catch return null;
        var lines = std.mem.splitScalar(u8, types.stdout, '\n');
        var mime: ?[]const u8 = null;
        while (lines.next()) |line| {
            if (std.mem.startsWith(u8, line, "image/")) {
                mime = line;
                break;
            }
        }
        const picked = mime orelse return null;
        const data = std.process.run(a, cmd.io, .{ .argv = &.{ "wl-paste", "--no-newline", "--type", picked }, .timeout = cmd.helper_timeout }) catch return null;
        return data.stdout;
    }
    const data = std.process.run(a, cmd.io, .{ .argv = &.{ "xclip", "-selection", "clipboard", "-t", "image/png", "-o" }, .timeout = cmd.helper_timeout }) catch return null;
    return data.stdout;
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
