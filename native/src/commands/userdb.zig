//! The user's data in one DuckDB file: `<userData>/vibecode.duckdb` (override: `VIBECODE_DB`).
//! Port of src-tauri/src/userdb.rs. Tables: meta, settings, ui_prefs, plan_items, open_chats, web_pages.
//! Secrets are not stored here.

const std = @import("std");
const cmd = @import("root.zig");
const db = @import("db.zig");

/// Each step runs once, in order; `meta.schema_version` records how far this file has got.
const migrations = [_][:0]const u8{
    \\CREATE TABLE settings (
    \\    key     VARCHAR PRIMARY KEY,
    \\    value   JSON NOT NULL,
    \\    updated TIMESTAMP NOT NULL DEFAULT now()
    \\);
    \\CREATE TABLE ui_prefs (
    \\    key     VARCHAR PRIMARY KEY,
    \\    value   VARCHAR NOT NULL,
    \\    updated TIMESTAMP NOT NULL DEFAULT now()
    \\);
    \\CREATE TABLE plan_items (
    \\    id          VARCHAR PRIMARY KEY,
    \\    project     VARCHAR,
    \\    parent_id   VARCHAR,
    \\    kind        VARCHAR NOT NULL CHECK (kind IN ('plan', 'task')),
    \\    title       VARCHAR NOT NULL,
    \\    description VARCHAR NOT NULL DEFAULT '',
    \\    position    INTEGER NOT NULL CHECK (position >= 0),
    \\    updated     TIMESTAMP NOT NULL DEFAULT now(),
    \\    CHECK (parent_id IS NULL OR parent_id <> id)
    \\);
    \\CREATE TABLE open_chats (
    \\    position        INTEGER PRIMARY KEY CHECK (position >= 0),
    \\    cwd             VARCHAR NOT NULL,
    \\    agent           VARCHAR,
    \\    session_id      VARCHAR,
    \\    title           VARCHAR NOT NULL,
    \\    pinned_title    BOOLEAN NOT NULL DEFAULT false,
    \\    model           VARCHAR,
    \\    effort          VARCHAR,
    \\    permission_mode VARCHAR,
    \\    host            VARCHAR,
    \\    active          BOOLEAN NOT NULL DEFAULT false
    \\);
    \\CREATE TABLE web_pages (
    \\    id       VARCHAR PRIMARY KEY,
    \\    url      VARCHAR NOT NULL,
    \\    title    VARCHAR NOT NULL DEFAULT '',
    \\    position INTEGER NOT NULL CHECK (position >= 0)
    \\);
    ,
    \\ALTER TABLE open_chats ADD COLUMN id VARCHAR;
};

var opened = false;

/// Opens the file and runs the pending migrations, once. On failure the message is in `db.lastError()`.
fn ensureOpen() !void {
    if (opened) return;
    var path_buffer: [4096]u8 = undefined;
    const path: [:0]const u8 = if (std.c.getenv("VIBECODE_DB")) |raw|
        std.mem.span(raw)
    else blk: {
        var dir_buffer: [4096]u8 = undefined;
        const dir = try cmd.userData(&dir_buffer);
        break :blk try std.fmt.bufPrintZ(&path_buffer, "{s}/vibecode.duckdb", .{dir});
    };
    try db.open(path);
    try db.exec("CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)");

    const have = try schemaVersion();
    if (have > migrations.len) return error.NewerSchema;
    for (migrations[have..], have..) |sql, done| {
        try db.begin();
        errdefer db.rollback();
        try db.exec(sql);
        var version_buffer: [16]u8 = undefined;
        const version = try std.fmt.bufPrint(&version_buffer, "{d}", .{done + 1});
        try db.run("INSERT INTO meta VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", &.{.{ .text = version }});
        try db.commit();
    }
    opened = true;
}

fn schemaVersion() !usize {
    var rows = try db.query("SELECT value FROM meta WHERE key = 'schema_version'", &.{});
    defer rows.deinit();
    if (rows.count() == 0) return 0;
    var scratch: [64]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&scratch);
    const text = (try rows.text(fba.allocator(), 0, 0)) orelse return 0;
    return std.fmt.parseInt(usize, text, 10) catch 0;
}

/// The user's database is opened on the first call that needs it; errors come back as the page's message.
fn failure(output: []u8, err: anyerror) ![]const u8 {
    if (err == error.NewerSchema) return cmd.fail(output, "the user database was written by a newer VIBE CODE");
    const detail = db.lastError();
    if (detail.len > 0) return cmd.fail(output, detail);
    return cmd.fail(output, @errorName(err));
}

const PlanItem = struct {
    id: []const u8,
    kind: []const u8,
    title: []const u8,
    description: []const u8 = "",
    parentId: ?[]const u8 = null,
};

const SavedChat = struct {
    id: ?[]const u8 = null,
    cwd: []const u8,
    title: []const u8,
    pinnedTitle: bool = false,
    agent: ?[]const u8 = null,
    sessionId: ?[]const u8 = null,
    model: ?[]const u8 = null,
    effort: ?[]const u8 = null,
    permissionMode: ?[]const u8 = null,
    host: ?[]const u8 = null,
    active: bool = false,
};

const WebPage = struct {
    id: []const u8,
    url: []const u8,
    title: []const u8 = "",
};

/// Serialises a value the way the page reads it: optional fields that are null are left out.
fn compactJson(a: std.mem.Allocator, value: anytype) ![]u8 {
    return std.json.Stringify.valueAlloc(a, value, .{ .emit_null_optional_fields = false });
}

fn optionalParam(value: ?[]const u8) db.Param {
    return if (value) |v| .{ .text = v } else .null_value;
}

fn loadPlans(a: std.mem.Allocator) ![]PlanItem {
    var rows = try db.query("SELECT id, kind, title, description, parent_id FROM plan_items ORDER BY position", &.{});
    defer rows.deinit();
    var items: std.ArrayList(PlanItem) = .empty;
    for (0..rows.count()) |r| {
        const id = (try rows.text(a, 0, r)) orelse continue;
        const kind = (try rows.text(a, 1, r)) orelse continue;
        const title = (try rows.text(a, 2, r)) orelse continue;
        const description = (try rows.text(a, 3, r)) orelse "";
        try items.append(a, .{ .id = id, .kind = kind, .title = title, .description = description, .parentId = try rows.text(a, 4, r) });
    }
    return items.items;
}

fn loadChats(a: std.mem.Allocator) ![]SavedChat {
    var rows = try db.query(
        "SELECT cwd, title, pinned_title, agent, session_id, model, effort, permission_mode, host, active, id FROM open_chats ORDER BY position",
        &.{},
    );
    defer rows.deinit();
    var chats: std.ArrayList(SavedChat) = .empty;
    for (0..rows.count()) |r| {
        const cwd = (try rows.text(a, 0, r)) orelse continue;
        const title = (try rows.text(a, 1, r)) orelse continue;
        try chats.append(a, .{
            .cwd = cwd,
            .title = title,
            .pinnedTitle = rows.boolean(2, r),
            .agent = try rows.text(a, 3, r),
            .sessionId = try rows.text(a, 4, r),
            .model = try rows.text(a, 5, r),
            .effort = try rows.text(a, 6, r),
            .permissionMode = try rows.text(a, 7, r),
            .host = try rows.text(a, 8, r),
            .active = rows.boolean(9, r),
            .id = try rows.text(a, 10, r),
        });
    }
    return chats.items;
}

fn loadPages(a: std.mem.Allocator) ![]WebPage {
    var rows = try db.query("SELECT id, url, title FROM web_pages ORDER BY position", &.{});
    defer rows.deinit();
    var pages: std.ArrayList(WebPage) = .empty;
    for (0..rows.count()) |r| {
        const id = (try rows.text(a, 0, r)) orelse continue;
        const url = (try rows.text(a, 1, r)) orelse continue;
        const title = (try rows.text(a, 2, r)) orelse "";
        try pages.append(a, .{ .id = id, .url = url, .title = title });
    }
    return pages.items;
}

/// Replaces the plans. A parent that is not in the list (or is the item itself) puts the item at the top level.
fn savePlans(items: []const PlanItem) !void {
    try db.begin();
    errdefer db.rollback();
    try db.exec("DELETE FROM plan_items");
    for (items, 0..) |item, pos| {
        var parent: ?[]const u8 = null;
        if (item.parentId) |p| {
            if (!std.mem.eql(u8, p, item.id)) {
                for (items) |other| {
                    if (std.mem.eql(u8, other.id, p)) parent = p;
                }
            }
        }
        try db.run(
            "INSERT INTO plan_items (id, parent_id, kind, title, description, position) VALUES (?, ?, ?, ?, ?, ?)",
            &.{ .{ .text = item.id }, optionalParam(parent), .{ .text = item.kind }, .{ .text = item.title }, .{ .text = item.description }, .{ .int = @intCast(pos) } },
        );
    }
    try db.commit();
}

fn saveChats(chats: []const SavedChat) !void {
    try db.begin();
    errdefer db.rollback();
    try db.exec("DELETE FROM open_chats");
    for (chats, 0..) |chat, pos| {
        try db.run(
            "INSERT INTO open_chats (position, cwd, agent, session_id, title, pinned_title, model, effort, permission_mode, host, active, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &.{
                .{ .int = @intCast(pos) },
                .{ .text = chat.cwd },
                optionalParam(chat.agent),
                optionalParam(chat.sessionId),
                .{ .text = chat.title },
                .{ .boolean = chat.pinnedTitle },
                optionalParam(chat.model),
                optionalParam(chat.effort),
                optionalParam(chat.permissionMode),
                optionalParam(chat.host),
                .{ .boolean = chat.active },
                optionalParam(chat.id),
            },
        );
    }
    try db.commit();
}

fn savePages(pages: []const WebPage) !void {
    try db.begin();
    errdefer db.rollback();
    try db.exec("DELETE FROM web_pages");
    for (pages, 0..) |page, pos| {
        try db.run(
            "INSERT INTO web_pages (id, url, title, position) VALUES (?, ?, ?, ?)",
            &.{ .{ .text = page.id }, .{ .text = page.url }, .{ .text = page.title }, .{ .int = @intCast(pos) } },
        );
    }
    try db.commit();
}

const Pref = struct { key: []const u8, value: []const u8 };

/// Everything the page reads at startup: the UI preferences, and each list as JSON text.
pub fn snapshot(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    ensureOpen() catch |err| return failure(output, err);

    var prefs = try db.query("SELECT key, value FROM ui_prefs", &.{});
    defer prefs.deinit();
    var entries: std.ArrayList(Pref) = .empty;
    for (0..prefs.count()) |r| {
        const key = (try prefs.text(a, 0, r)) orelse continue;
        const value = (try prefs.text(a, 1, r)) orelse continue;
        try entries.append(a, .{ .key = key, .value = value });
    }

    const plans = try compactJson(a, try loadPlans(a));
    const chats = try compactJson(a, try loadChats(a));
    const pages = try compactJson(a, try loadPages(a));

    var writer = std.Io.Writer.fixed(output);
    var s: std.json.Stringify = .{ .writer = &writer };
    try s.beginObject();
    try s.objectField("prefs");
    try s.beginObject();
    for (entries.items) |e| {
        try s.objectField(e.key);
        try s.write(e.value);
    }
    try s.endObject();
    try s.objectField("plans");
    try s.write(plans);
    try s.objectField("chats");
    try s.write(chats);
    try s.objectField("pages");
    try s.write(pages);
    try s.endObject();
    return writer.buffered();
}

/// `{ entries: { key: text | null } }`: a null value deletes the key.
pub fn prefsWrite(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    ensureOpen() catch |err| return failure(output, err);

    var scratch: [65536]u8 = undefined;
    const args = try cmd.args(struct { entries: std.json.Value }, invocation, &scratch);
    try db.begin();
    errdefer db.rollback();
    for (args.entries.object.keys(), args.entries.object.values()) |key, value| {
        switch (value) {
            .string => |text| try db.run(
                "INSERT INTO ui_prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = now()",
                &.{ .{ .text = key }, .{ .text = text } },
            ),
            else => try db.run("DELETE FROM ui_prefs WHERE key = ?", &.{.{ .text = key }}),
        }
    }
    try db.commit();
    return cmd.json(output, null);
}

/// `{ table, json }`: replaces one list. `table` is "plans", "chats" or "pages"; `json` is the whole list.
pub fn save(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    ensureOpen() catch |err| return failure(output, err);

    var scratch: [8192]u8 = undefined;
    const args = try cmd.args(struct { table: []const u8, json: []const u8 }, invocation, &scratch);
    const result = if (std.mem.eql(u8, args.table, "plans"))
        savePlans(try std.json.parseFromSliceLeaky([]PlanItem, a, args.json, .{ .ignore_unknown_fields = true }))
    else if (std.mem.eql(u8, args.table, "chats"))
        saveChats(try std.json.parseFromSliceLeaky([]SavedChat, a, args.json, .{ .ignore_unknown_fields = true }))
    else if (std.mem.eql(u8, args.table, "pages"))
        savePages(try std.json.parseFromSliceLeaky([]WebPage, a, args.json, .{ .ignore_unknown_fields = true }))
    else
        return cmd.fail(output, "unknown table");
    result catch |err| return failure(output, err);
    return cmd.json(output, null);
}

/// Folds the write-ahead log into the file so a copy of it is complete (on quit).
pub fn checkpoint() void {
    if (opened) db.checkpoint();
}
