//! App settings, kept in the user database's `settings` table (one row per setting, value as JSON).
//! Port of src-tauri/src/settings.rs. The cache lives in its own arena, replaced on every update.

const std = @import("std");
const cmd = @import("root.zig");
const db = @import("db.zig");
const userdb = @import("userdb.zig");

pub const AppSettings = struct {
    recentFolders: []const []const u8 = &[_][]const u8{},
    lastFolder: ?[]const u8 = null,
    mode: []const u8 = "window",
    hotkey: []const u8 = "Alt+`",
    dropHeight: f64 = 0.6,
    dropOpacity: f64 = 0.97,
    hideOnBlur: bool = false,
    theme: []const u8 = "system",
    model: []const u8 = "claude-opus-5-5",
    effort: []const u8 = "",
    permissionMode: []const u8 = "",
    seeThrough: bool = false,
    editorFont: []const u8 = "JetBrains Mono",
    editorFontSize: f64 = 12.0,
    editorLigatures: bool = true,
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

/// The settings as the page reads them. Loaded from the database on first use; an old `settings.json`
/// from the Electron build is imported the first time there is nothing in the database.
pub fn get() AppSettings {
    if (!loaded) {
        loaded = true;
        var arena = std.heap.ArenaAllocator.init(cmd.gpa);
        defer arena.deinit();
        const value = loadFromDatabase(arena.allocator()) catch loadLegacyFile(arena.allocator()) catch AppSettings{};
        replaceCache(value) catch {};
    }
    return current;
}

/// The Electron build's `settings.json`, read once when the database has no settings yet.
fn loadLegacyFile(a: std.mem.Allocator) !AppSettings {
    var dir_buffer: [4096]u8 = undefined;
    var path_buffer: [4200]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buffer, "{s}/settings.json", .{try cmd.userData(&dir_buffer)});
    const text = try std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(1024 * 1024));
    const value = try std.json.parseFromSliceLeaky(AppSettings, a, text, .{ .ignore_unknown_fields = true });
    try userdb.ensureOpen();
    try persist(a, value);
    return value;
}

fn loadFromDatabase(a: std.mem.Allocator) !AppSettings {
    try userdb.ensureOpen();
    var rows = try db.query("SELECT key, value::VARCHAR FROM settings", &.{});
    defer rows.deinit();
    if (rows.count() == 0) return error.NoSettings;

    var object = std.json.ObjectMap.empty;
    for (0..rows.count()) |r| {
        const key = (try rows.text(a, 0, r)) orelse continue;
        const raw = (try rows.text(a, 1, r)) orelse continue;
        const value = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch continue;
        try object.put(a, key, value);
    }
    if (object.count() == 0) return error.NoSettings;
    return std.json.parseFromValueLeaky(AppSettings, a, .{ .object = object }, .{ .ignore_unknown_fields = true });
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
    try persist(a, current);
    return current;
}

fn persist(a: std.mem.Allocator, value: AppSettings) !void {
    const text = try std.json.Stringify.valueAlloc(a, value, .{ .emit_null_optional_fields = false });
    const object = (try std.json.parseFromSliceLeaky(std.json.Value, a, text, .{})).object;
    try userdb.ensureOpen();
    try db.begin();
    errdefer db.rollback();
    for (object.keys(), object.values()) |key, field| {
        const json_text = try std.json.Stringify.valueAlloc(a, field, .{});
        try db.run(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = now()",
            &.{ .{ .text = key }, .{ .text = json_text } },
        );
    }
    try db.commit();
}

pub fn rememberFolder(folder: []const u8) !AppSettings {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const current_settings = get();

    var folders: std.ArrayList([]const u8) = .empty;
    try folders.append(a, folder);
    const lower = try std.ascii.allocLowerString(a, folder);
    for (current_settings.recentFolders) |existing| {
        const existing_lower = try std.ascii.allocLowerString(a, existing);
        if (!std.mem.eql(u8, existing_lower, lower)) try folders.append(a, existing);
    }
    if (folders.items.len > 10) folders.shrinkRetainingCapacity(10);

    var patch = std.json.ObjectMap.empty;
    try patch.put(a, "recentFolders", try std.json.parseFromSliceLeaky(std.json.Value, a, try std.json.Stringify.valueAlloc(a, folders.items, .{}), .{}));
    try patch.put(a, "lastFolder", .{ .string = folder });
    return update(patch);
}
