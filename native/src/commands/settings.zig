//! App settings, kept in `settings.json` in the user data folder. Only what the shell itself uses.

const std = @import("std");
const cmd = @import("root.zig");

pub const AppSettings = struct {
    theme: []const u8 = "system",
    mode: []const u8 = "window",
    hotkey: []const u8 = "Alt+`",
    dropHeight: f64 = 0.6,
    dropOpacity: f64 = 0.97,
    hideOnBlur: bool = false,
    seeThrough: bool = false,
    openAtLogin: ?bool = null,
};

var arena_state: ?std.heap.ArenaAllocator = null;
var current: AppSettings = .{};
var loaded = false;

fn replaceCache(value: AppSettings) !void {
    var fresh = std.heap.ArenaAllocator.init(cmd.gpa);
    errdefer fresh.deinit();
    const copy = try cloneSettings(fresh.allocator(), value);
    if (arena_state) |*old| old.deinit();
    arena_state = fresh;
    current = copy;
}

fn cloneSettings(a: std.mem.Allocator, value: AppSettings) !AppSettings {
    const text = try std.json.Stringify.valueAlloc(a, value, .{ .emit_null_optional_fields = false });
    return std.json.parseFromSliceLeaky(AppSettings, a, text, .{ .ignore_unknown_fields = true });
}

fn filePath(buffer: []u8) ![]const u8 {
    var dir_buffer: [4096]u8 = undefined;
    return std.fmt.bufPrint(buffer, "{s}/settings.json", .{try cmd.userData(&dir_buffer)});
}

/// The settings as the page reads them. Read from the file on first use; defaults when it is missing or broken.
pub fn get() AppSettings {
    if (!loaded) {
        loaded = true;
        var arena = std.heap.ArenaAllocator.init(cmd.gpa);
        defer arena.deinit();
        const value = loadFile(arena.allocator()) catch AppSettings{};
        replaceCache(value) catch {};
    }
    return current;
}

fn loadFile(a: std.mem.Allocator) !AppSettings {
    var path_buffer: [4200]u8 = undefined;
    const path = try filePath(&path_buffer);
    const text = try std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(1024 * 1024));
    return std.json.parseFromSliceLeaky(AppSettings, a, text, .{ .ignore_unknown_fields = true });
}

/// Merges a partial patch (camelCase keys) into the settings and saves them. A patch that does not
/// produce valid settings leaves the old ones in place.
pub fn update(patch: std.json.ObjectMap) !AppSettings {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const base_text = try std.json.Stringify.valueAlloc(a, get(), .{ .emit_null_optional_fields = false });
    var merged = (try std.json.parseFromSliceLeaky(std.json.Value, a, base_text, .{})).object;
    for (patch.keys(), patch.values()) |key, value| try merged.put(a, key, value);

    const next = std.json.parseFromValueLeaky(AppSettings, a, .{ .object = merged }, .{ .ignore_unknown_fields = true }) catch return get();
    try replaceCache(next);
    persist(a, current) catch {};
    return current;
}

fn persist(a: std.mem.Allocator, value: AppSettings) !void {
    var path_buffer: [4200]u8 = undefined;
    const path = try filePath(&path_buffer);
    const text = try std.json.Stringify.valueAlloc(a, value, .{ .emit_null_optional_fields = false });
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = path, .data = text });
}
