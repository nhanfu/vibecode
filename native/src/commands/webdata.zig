
const std = @import("std");
const builtin = @import("builtin");
const cmd = @import("root.zig");
const sqlite = @cImport(@cInclude("sqlite3.h"));

const max_history = 20000;
const save_delay_ms: i64 = 1000;
const file_name = "web-data.json";
const max_suggestions = 8;
const max_google_suggestions = 5;

const HistoryEntry = struct {
    url: []const u8,
    title: []const u8,
    visits: i64,
    last: i64,
};

const Found = struct {
    url: []const u8,
    title: []const u8,
    bookmark: bool,
    visits: i64,
    last: i64,
};

const Scored = struct {
    score: f64,
    found: Found,
};

var mutex: std.Io.Mutex = .init;
var loaded = false;
var store: std.heap.ArenaAllocator = undefined;
var imported_at: u64 = 0;
var bookmarks: std.json.Value = .null;
var history: std.StringHashMap(HistoryEntry) = undefined;
var save_gen: u64 = 0;

fn lock() void {
    mutex.lockUncancelable(cmd.io);
}

fn unlock() void {
    mutex.unlock(cmd.io);
}

fn userDataFile(buffer: []u8) ![]const u8 {
    var dir_buffer: [4096]u8 = undefined;
    const dir = try cmd.userData(&dir_buffer);
    return std.fmt.bufPrint(buffer, "{s}/{s}", .{ dir, file_name });
}

fn isHttp(url: []const u8) bool {
    return std.ascii.startsWithIgnoreCase(url, "http:") or std.ascii.startsWithIgnoreCase(url, "https:");
}

fn child(v: std.json.Value, key: []const u8) ?std.json.Value {
    if (v != .object) return null;
    return v.object.get(key);
}

fn nested(v: std.json.Value, first: []const u8, second: []const u8) ?std.json.Value {
    return child(child(v, first) orelse return null, second);
}

fn stringField(v: std.json.Value, key: []const u8) ?[]const u8 {
    const field = child(v, key) orelse return null;
    return switch (field) {
        .string => |s| s,
        else => null,
    };
}

fn nonEmpty(s: ?[]const u8) ?[]const u8 {
    const value = s orelse return null;
    return if (value.len == 0) null else value;
}

fn integerField(v: std.json.Value, key: []const u8) i64 {
    const field = child(v, key) orelse return 0;
    return switch (field) {
        .integer => |i| i,
        else => 0,
    };
}

fn ensureLoaded() !void {
    if (loaded) return;
    loaded = true;
    store = std.heap.ArenaAllocator.init(cmd.gpa);
    const a = store.allocator();
    bookmarks = .{ .array = std.json.Array.init(a) };
    history = std.StringHashMap(HistoryEntry).init(a);

    var buffer: [8192]u8 = undefined;
    const path = try userDataFile(&buffer);
    const text = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(256 * 1024 * 1024)) catch return;
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .ignore_unknown_fields = true }) catch return;
    if (root != .object) return;
    if (root.object.get("importedAt")) |v| {
        imported_at = switch (v) {
            .integer => |i| if (i >= 0) @intCast(i) else 0,
            else => 0,
        };
    }
    if (root.object.get("bookmarks")) |v| {
        if (v == .array) bookmarks = v;
    }
    if (root.object.get("history")) |v| {
        if (v != .array) return;
        for (v.array.items) |item| {
            const url = stringField(item, "url") orelse continue;
            try history.put(url, .{
                .url = url,
                .title = stringField(item, "title") orelse "",
                .visits = integerField(item, "visits"),
                .last = integerField(item, "last"),
            });
        }
    }
}

fn scheduleSave() void {
    save_gen += 1;
    const thread = std.Thread.spawn(.{}, saveLater, .{save_gen}) catch return;
    thread.detach();
}

fn saveLater(generation: u64) void {
    std.Io.sleep(cmd.io, std.Io.Duration.fromMilliseconds(save_delay_ms), .real) catch {};
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    var text: ?[]u8 = null;
    lock();
    if (save_gen == generation) text = serialize(arena.allocator()) catch null;
    unlock();
    if (text) |bytes| writeAtomic(bytes) catch {};
}

fn newerFirst(_: void, l: HistoryEntry, r: HistoryEntry) bool {
    return l.last > r.last;
}

fn serialize(a: std.mem.Allocator) ![]u8 {
    var list: std.ArrayList(HistoryEntry) = .empty;
    var it = history.valueIterator();
    while (it.next()) |h| try list.append(a, h.*);
    std.sort.block(HistoryEntry, list.items, {}, newerFirst);
    const count = @min(list.items.len, max_history);

    var entries = std.json.Array.init(a);
    for (list.items[0..count]) |h| {
        var object = std.json.ObjectMap.empty;
        try object.put(a, "url", .{ .string = h.url });
        try object.put(a, "title", .{ .string = h.title });
        try object.put(a, "visits", .{ .integer = h.visits });
        try object.put(a, "last", .{ .integer = h.last });
        try entries.append(.{ .object = object });
    }

    var root = std.json.ObjectMap.empty;
    try root.put(a, "importedAt", .{ .integer = @intCast(imported_at) });
    try root.put(a, "bookmarks", bookmarks);
    try root.put(a, "history", .{ .array = entries });
    return std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{});
}

fn writeAtomic(bytes: []const u8) !void {
    var dir_buffer: [4096]u8 = undefined;
    const dir = try cmd.userData(&dir_buffer);
    const work = std.Io.Dir.cwd();
    try work.createDirPath(cmd.io, dir);
    var path_buffer: [8192]u8 = undefined;
    const path = try userDataFile(&path_buffer);
    var tmp_buffer: [8192]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buffer, "{s}.tmp", .{path});
    try work.writeFile(cmd.io, .{ .sub_path = tmp, .data = bytes });
    try work.rename(tmp, work, path, cmd.io);
}

fn webDataJson(output: []u8) ![]const u8 {
    lock();
    ensureLoaded() catch |err| {
        unlock();
        return cmd.fail(output, @errorName(err));
    };
    const at = imported_at;
    const marks = bookmarks;
    unlock();
    return cmd.json(output, .{ .importedAt = at, .bookmarks = marks, .chromeFound = chromeInstalled() });
}

pub fn webData(_: cmd.Invocation, output: []u8) ![]const u8 {
    return webDataJson(output) catch |err| cmd.fail(output, @errorName(err));
}


fn chromeRoot(buffer: []u8) ![]const u8 {
    const home = std.mem.span(std.c.getenv("HOME") orelse return error.NoHome);
    return if (builtin.os.tag == .macos)
        std.fmt.bufPrint(buffer, "{s}/Library/Application Support/Google/Chrome", .{home})
    else
        std.fmt.bufPrint(buffer, "{s}/.config/google-chrome", .{home});
}

fn chromeInstalled() bool {
    var root_buffer: [4096]u8 = undefined;
    const root = chromeRoot(&root_buffer) catch return false;
    var path_buffer: [4200]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "{s}/Local State", .{root}) catch return false;
    std.Io.Dir.cwd().access(cmd.io, path, .{}) catch return false;
    return true;
}

fn toBookmark(a: std.mem.Allocator, node: std.json.Value) !?std.json.Value {
    const kind = stringField(node, "type") orelse return null;
    const title = stringField(node, "name") orelse "";
    var object = std.json.ObjectMap.empty;
    try object.put(a, "title", .{ .string = title });
    if (std.mem.eql(u8, kind, "url")) {
        const url = nonEmpty(stringField(node, "url")) orelse return null;
        try object.put(a, "url", .{ .string = url });
    } else if (std.mem.eql(u8, kind, "folder")) {
        var children = std.json.Array.init(a);
        if (child(node, "children")) |list| {
            if (list == .array) {
                for (list.array.items) |item| {
                    if (try toBookmark(a, item)) |b| try children.append(b);
                }
            }
        }
        try object.put(a, "children", .{ .array = children });
    } else return null;
    return .{ .object = object };
}

fn hasLinkOrChildren(b: std.json.Value) bool {
    if (child(b, "url") != null) return true;
    const kids = child(b, "children") orelse return false;
    return kids == .array and kids.array.items.len != 0;
}

fn addNodes(a: std.mem.Allocator, to: *std.json.Array, seen: *std.StringHashMap(void), nodes: ?std.json.Value) !void {
    const list = nodes orelse return;
    if (list != .array) return;
    for (list.array.items) |node| {
        const url = nonEmpty(stringField(node, "url"));
        const is_url = if (stringField(node, "type")) |t| std.mem.eql(u8, t, "url") else false;
        if (is_url) {
            const u = url orelse continue;
            if (seen.contains(u)) continue;
        }
        if (url) |u| try seen.put(u, {});
        const bookmark = (try toBookmark(a, node)) orelse continue;
        if (hasLinkOrChildren(bookmark)) try to.append(bookmark);
    }
}

fn importBookmarks(a: std.mem.Allocator, root: []const u8, dirs: []const []const u8) !std.json.Value {
    var bar = std.json.Array.init(a);
    var other = std.json.Array.init(a);
    var seen = std.StringHashMap(void).init(a);
    for (dirs) |dir| {
        for ([_][]const u8{ "AccountBookmarks", "Bookmarks" }) |name| {
            const path = try std.fs.path.join(a, &.{ root, dir, name });
            const text = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(256 * 1024 * 1024)) catch continue;
            const file = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .ignore_unknown_fields = true }) catch continue;
            const roots = child(file, "roots") orelse continue;
            try addNodes(a, &bar, &seen, nested(roots, "bookmark_bar", "children"));
            try addNodes(a, &other, &seen, nested(roots, "other", "children"));
            try addNodes(a, &other, &seen, nested(roots, "synced", "children"));
        }
    }
    if (other.items.len != 0) {
        var folder = std.json.ObjectMap.empty;
        try folder.put(a, "title", .{ .string = "Other bookmarks" });
        try folder.put(a, "children", .{ .array = other });
        try bar.append(.{ .object = folder });
    }
    return .{ .array = bar };
}

fn naturalCmp(x: []const u8, y: []const u8) std.math.Order {
    var i: usize = 0;
    var j: usize = 0;
    while (i < x.len and j < y.len) {
        const ex = chunkEnd(x, i);
        const ey = chunkEnd(y, j);
        const cx = x[i..ex];
        const cy = y[j..ey];
        const ord = if (std.ascii.isDigit(x[i]) and std.ascii.isDigit(y[j]))
            digitOrder(cx, cy)
        else
            textOrder(cx, cy);
        if (ord != .eq) return ord;
        i = ex;
        j = ey;
    }
    if (i == x.len and j == y.len) return .eq;
    return if (i == x.len) .lt else .gt;
}

fn chunkEnd(s: []const u8, start: usize) usize {
    const digit = std.ascii.isDigit(s[start]);
    var end = start + 1;
    while (end < s.len and std.ascii.isDigit(s[end]) == digit) end += 1;
    return end;
}

fn digitOrder(x: []const u8, y: []const u8) std.math.Order {
    const tx = std.mem.trimStart(u8, x, "0");
    const ty = std.mem.trimStart(u8, y, "0");
    if (tx.len != ty.len) return std.math.order(tx.len, ty.len);
    return std.mem.order(u8, tx, ty);
}

fn textOrder(x: []const u8, y: []const u8) std.math.Order {
    const lower = lowerOrder(x, y);
    if (lower != .eq) return lower;
    return std.mem.order(u8, x, y);
}

fn lowerOrder(x: []const u8, y: []const u8) std.math.Order {
    const n = @min(x.len, y.len);
    for (x[0..n], y[0..n]) |a, b| {
        const la = std.ascii.toLower(a);
        const lb = std.ascii.toLower(b);
        if (la != lb) return std.math.order(la, lb);
    }
    return std.math.order(x.len, y.len);
}

fn profileLess(_: void, l: []const u8, r: []const u8) bool {
    const l_default = std.mem.eql(u8, l, "Default");
    const r_default = std.mem.eql(u8, r, "Default");
    if (l_default or r_default) return l_default and !r_default;
    return naturalCmp(l, r) == .lt;
}

fn profiles(a: std.mem.Allocator, root: []const u8) ![]const []const u8 {
    const fallback = [_][]const u8{"Default"};
    const path = try std.fmt.allocPrint(a, "{s}/Local State", .{root});
    const text = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(64 * 1024 * 1024)) catch return a.dupe([]const u8, &fallback);
    const state = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{ .ignore_unknown_fields = true }) catch return a.dupe([]const u8, &fallback);
    var names: std.ArrayList([]const u8) = .empty;
    if (nested(state, "profile", "info_cache")) |cache| {
        if (cache == .object) {
            for (cache.object.keys()) |key| try names.append(a, key);
        }
    }
    std.sort.block([]const u8, names.items, {}, profileLess);
    return names.items;
}

fn readHistory(a: std.mem.Allocator, src: []const u8, tmp: []const u8) ![]HistoryEntry {
    const work = std.Io.Dir.cwd();
    const bytes = work.readFileAlloc(cmd.io, src, a, .limited(1024 * 1024 * 1024)) catch return &.{};
    try work.writeFile(cmd.io, .{ .sub_path = tmp, .data = bytes });
    defer work.deleteFile(cmd.io, tmp) catch {};

    const tmp_z = try a.dupeZ(u8, tmp);
    var db: ?*sqlite.sqlite3 = null;
    defer _ = sqlite.sqlite3_close(db);
    if (sqlite.sqlite3_open_v2(tmp_z.ptr, &db, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOMUTEX, null) != sqlite.SQLITE_OK) return error.HistoryOpen;

    const sql = std.fmt.comptimePrint(
        "SELECT url, title, visit_count, last_visit_time / 1000 - 11644473600000 FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT {d}",
        .{max_history},
    );
    var stmt: ?*sqlite.sqlite3_stmt = null;
    if (sqlite.sqlite3_prepare_v2(db, sql.ptr, @intCast(sql.len), &stmt, null) != sqlite.SQLITE_OK) return error.HistoryQuery;
    defer _ = sqlite.sqlite3_finalize(stmt);

    var rows: std.ArrayList(HistoryEntry) = .empty;
    while (sqlite.sqlite3_step(stmt) == sqlite.SQLITE_ROW) {
        try rows.append(a, .{
            .url = try columnText(a, stmt, 0),
            .title = try columnText(a, stmt, 1),
            .visits = @intCast(sqlite.sqlite3_column_int64(stmt, 2)),
            .last = @intCast(sqlite.sqlite3_column_int64(stmt, 3)),
        });
    }
    return rows.items;
}

fn columnText(a: std.mem.Allocator, stmt: ?*sqlite.sqlite3_stmt, column: c_int) ![]const u8 {
    const raw = sqlite.sqlite3_column_text(stmt, column);
    if (raw == null) return "";
    const bytes: [*]const u8 = @ptrCast(raw);
    const len: usize = @intCast(sqlite.sqlite3_column_bytes(stmt, column));
    return a.dupe(u8, bytes[0..len]);
}

fn cloneValue(a: std.mem.Allocator, v: std.json.Value) !std.json.Value {
    return switch (v) {
        .string => |s| .{ .string = try a.dupe(u8, s) },
        .array => |arr| blk: {
            var out = std.json.Array.init(a);
            for (arr.items) |item| try out.append(try cloneValue(a, item));
            break :blk .{ .array = out };
        },
        .object => |obj| blk: {
            var out = std.json.ObjectMap.empty;
            for (obj.keys(), obj.values()) |key, val| try out.put(a, try a.dupe(u8, key), try cloneValue(a, val));
            break :blk .{ .object = out };
        },
        else => v,
    };
}

fn mergeRow(row: HistoryEntry) !void {
    if (!isHttp(row.url)) return;
    const a = store.allocator();
    if (history.getPtr(row.url)) |h| {
        h.visits += row.visits;
        if (row.last > h.last) {
            h.last = row.last;
            if (row.title.len != 0) h.title = try a.dupe(u8, row.title);
        }
    } else {
        const url = try a.dupe(u8, row.url);
        try history.put(url, .{
            .url = url,
            .title = try a.dupe(u8, row.title),
            .visits = row.visits,
            .last = row.last,
        });
    }
}

fn importChrome() !void {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    var root_buffer: [4096]u8 = undefined;
    const root = try chromeRoot(&root_buffer);
    const dirs = try profiles(a, root);
    const marks = try importBookmarks(a, root, dirs);

    var tmp_buffer: [4096]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buffer, "{s}/vibe-chrome-history-{d}.db", .{ cmd.tempDir(), cmd.nowMs() });
    var histories: std.ArrayList([]HistoryEntry) = .empty;
    for (dirs) |dir| {
        const src = try std.fmt.allocPrint(a, "{s}/{s}/History", .{ root, dir });
        const rows = readHistory(a, src, tmp) catch continue;
        try histories.append(a, rows);
    }

    lock();
    defer unlock();
    try ensureLoaded();
    bookmarks = try cloneValue(store.allocator(), marks);
    for (histories.items) |rows| {
        for (rows) |row| try mergeRow(row);
    }
    imported_at = cmd.nowMs();
    scheduleSave();
}

pub fn webImportChrome(_: cmd.Invocation, output: []u8) ![]const u8 {
    importChrome() catch |err| return cmd.fail(output, @errorName(err));
    return webDataJson(output);
}


fn recordVisit(url: []const u8, title: []const u8) !void {
    if (!isHttp(url)) return;
    lock();
    defer unlock();
    try ensureLoaded();
    const a = store.allocator();
    const now: i64 = @intCast(cmd.nowMs());
    if (history.getPtr(url)) |h| {
        h.visits += 1;
        h.last = now;
        if (title.len != 0) h.title = try a.dupe(u8, title);
    } else {
        const owned = try a.dupe(u8, url);
        try history.put(owned, .{
            .url = owned,
            .title = try a.dupe(u8, title),
            .visits = 1,
            .last = now,
        });
    }
    scheduleSave();
}

pub fn webVisit(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { url: []const u8 = "", title: ?[]const u8 = null }, arena.allocator(), invocation);
    recordVisit(args.url, args.title orelse "") catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, null);
}

fn setVisitTitle(url: []const u8, title: []const u8) !void {
    lock();
    defer unlock();
    try ensureLoaded();
    const h = history.getPtr(url) orelse return;
    if (title.len == 0 or std.mem.eql(u8, h.title, title)) return;
    h.title = try store.allocator().dupe(u8, title);
    scheduleSave();
}

pub fn webTitle(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { url: []const u8 = "", title: []const u8 = "" }, arena.allocator(), invocation);
    setVisitTitle(args.url, args.title) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, null);
}

fn matchesAll(words: []const []const u8, url: []const u8, title: []const u8) bool {
    for (words) |w| {
        if (std.ascii.indexOfIgnoreCase(url, w) == null and std.ascii.indexOfIgnoreCase(title, w) == null) return false;
    }
    return true;
}

fn walkBookmarks(a: std.mem.Allocator, list: std.json.Value, words: []const []const u8, found: *std.ArrayList(Found), index: *std.StringHashMap(usize)) !void {
    if (list != .array) return;
    for (list.array.items) |node| {
        if (child(node, "children")) |kids| {
            if (kids == .array) {
                try walkBookmarks(a, kids, words, found, index);
                continue;
            }
        }
        const url = nonEmpty(stringField(node, "url")) orelse continue;
        const title = stringField(node, "title") orelse "";
        if (!matchesAll(words, url, title)) continue;
        const f = Found{ .url = url, .title = title, .bookmark = true, .visits = 0, .last = 0 };
        if (index.get(url)) |i| {
            found.items[i] = f;
        } else {
            try index.put(url, found.items.len);
            try found.append(a, f);
        }
    }
}

fn stripScheme(url: []const u8) []const u8 {
    var rest = url;
    if (std.ascii.startsWithIgnoreCase(rest, "https://")) {
        rest = rest[8..];
    } else if (std.ascii.startsWithIgnoreCase(rest, "http://")) {
        rest = rest[7..];
    } else return url;
    if (std.ascii.startsWithIgnoreCase(rest, "www.")) rest = rest[4..];
    return rest;
}

fn score(a: std.mem.Allocator, f: Found, now: f64, first: []const u8) !f64 {
    const bare = try std.ascii.allocLowerString(a, stripScheme(f.url));
    const age: f64 = if (f.last != 0) (now - @as(f64, @floatFromInt(f.last))) / (30.0 * 864e5) else 3.0;
    const visits: f64 = @floatFromInt(f.visits);
    var value = @log(1.0 + visits) - @min(age, 6.0);
    if (f.bookmark) value += 2.0;
    if (std.mem.startsWith(u8, bare, first)) value += 5.0;
    const units = std.unicode.calcUtf16LeLen(bare) catch bare.len;
    value -= @as(f64, @floatFromInt(units)) / 60.0;
    return value;
}

fn scoredHigher(_: void, l: Scored, r: Scored) bool {
    return l.score > r.score;
}

fn suggest(a: std.mem.Allocator, query: []const u8, limit: usize) ![]Found {
    const lower = try std.ascii.allocLowerString(a, query);
    var word_list: std.ArrayList([]const u8) = .empty;
    var tokens = std.mem.tokenizeAny(u8, lower, " \t\r\n");
    while (tokens.next()) |w| try word_list.append(a, w);
    const words = word_list.items;
    if (words.len == 0) return &.{};

    lock();
    defer unlock();
    try ensureLoaded();

    var found: std.ArrayList(Found) = .empty;
    var index = std.StringHashMap(usize).init(a);
    try walkBookmarks(a, bookmarks, words, &found, &index);
    var it = history.valueIterator();
    while (it.next()) |h| {
        if (!matchesAll(words, h.url, h.title)) continue;
        if (index.get(h.url)) |i| {
            found.items[i].visits = h.visits;
            found.items[i].last = h.last;
        } else {
            try index.put(h.url, found.items.len);
            try found.append(a, .{ .url = h.url, .title = h.title, .bookmark = false, .visits = h.visits, .last = h.last });
        }
    }

    const now: f64 = @floatFromInt(cmd.nowMs());
    const scored = try a.alloc(Scored, found.items.len);
    for (found.items, 0..) |f, i| {
        scored[i] = .{ .score = try score(a, f, now, words[0]), .found = f };
    }
    std.sort.block(Scored, scored, {}, scoredHigher);
    const count = @min(scored.len, limit);
    const out = try a.alloc(Found, count);
    for (scored[0..count], 0..) |s, i| out[i] = s.found;
    return out;
}

fn suggestionValue(a: std.mem.Allocator, url: []const u8, title: []const u8, bookmark: bool, search: bool) !std.json.Value {
    var object = std.json.ObjectMap.empty;
    try object.put(a, "url", .{ .string = url });
    try object.put(a, "title", .{ .string = title });
    if (bookmark) try object.put(a, "bookmark", .{ .bool = true });
    if (search) try object.put(a, "search", .{ .bool = true });
    return .{ .object = object };
}

fn formEncode(a: std.mem.Allocator, text: []const u8) ![]u8 {
    const hex = "0123456789ABCDEF";
    var out: std.ArrayList(u8) = .empty;
    for (text) |c| {
        if (std.ascii.isAlphanumeric(c) or c == '*' or c == '-' or c == '.' or c == '_') {
            try out.append(a, c);
        } else if (c == ' ') {
            try out.append(a, '+');
        } else {
            try out.appendSlice(a, &.{ '%', hex[c >> 4], hex[c & 15] });
        }
    }
    return out.items;
}

fn googleSuggest(a: std.mem.Allocator, query: []const u8) ![]const []const u8 {
    const encoded = try formEncode(a, query);
    const url = try std.fmt.allocPrint(a, "https://suggestqueries.google.com/complete/search?client=firefox&q={s}", .{encoded});
    const argv = [_][]const u8{ "curl", "-s", "--max-time", "1.5", url };
    const result = std.process.run(a, cmd.io, .{
        .argv = &argv,
        .stdout_limit = .limited(1024 * 1024),
        .timeout = cmd.helper_timeout,
    }) catch return &.{};
    switch (result.term) {
        .exited => |code| if (code != 0) return &.{},
        else => return &.{},
    }
    const body = std.json.parseFromSliceLeaky(std.json.Value, a, result.stdout, .{}) catch return &.{};
    if (body != .array or body.array.items.len < 2) return &.{};
    const second = body.array.items[1];
    if (second != .array) return &.{};
    var texts: std.ArrayList([]const u8) = .empty;
    for (second.array.items) |item| {
        if (item == .string) try texts.append(a, item.string);
    }
    return texts.items;
}

pub fn webSuggest(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { query: []const u8 = "" }, a, invocation);
    const q = std.mem.trim(u8, args.query, " \t\r\n");

    var list = std.json.Array.init(a);
    const found = suggest(a, q, max_suggestions) catch |err| return cmd.fail(output, @errorName(err));
    for (found) |f| try list.append(try suggestionValue(a, f.url, f.title, f.bookmark, false));

    if (q.len != 0 and !std.mem.startsWith(u8, q, "http")) {
        const texts: []const []const u8 = googleSuggest(a, q) catch &.{};
        for (texts[0..@min(texts.len, max_google_suggestions)]) |text| {
            if (titleListed(list.items, text)) continue;
            const encoded = try formEncode(a, text);
            const url = try std.fmt.allocPrint(a, "https://www.google.com/search?q={s}", .{encoded});
            try list.append(try suggestionValue(a, url, text, false, true));
        }
    }
    return cmd.json(output, std.json.Value{ .array = list });
}

fn titleListed(items: []const std.json.Value, text: []const u8) bool {
    for (items) |item| {
        const title = stringField(item, "title") orelse continue;
        if (std.ascii.eqlIgnoreCase(title, text)) return true;
    }
    return false;
}
