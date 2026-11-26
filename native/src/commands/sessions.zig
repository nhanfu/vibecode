//! The Claude Code session store (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`), read for the
//! session list and the chat detail commands (images, context, tasks, subagents, changes). Port of
//! src-tauri/src/sessions.rs. The file watcher and the per-session incremental caches are not ported:
//! each detail call reads its transcript again.
//! The JSONL format is internal to Claude Code, so everything here is best-effort.

const std = @import("std");
const cmd = @import("root.zig");

const Allocator = std.mem.Allocator;
const Obj = std.json.ObjectMap;

const head_bytes: u64 = 96 * 1024;
const tail_bytes: u64 = 256 * 1024;

const SessionInfo = struct {
    id: []const u8,
    title: []const u8,
    cwd: []const u8,
    projectCwd: []const u8,
    created: i64,
    updated: i64,
    cwdExists: bool,
};

const ProjectGroup = struct {
    key: []const u8,
    cwd: []const u8,
    name: []const u8,
    updated: i64,
    sessions: []const SessionInfo,
};

/// `~/.claude/projects`, from $HOME.
fn projectsDir(a: Allocator) ![]const u8 {
    const home = std.mem.span(std.c.getenv("HOME") orelse return error.NoHome);
    return std.fmt.allocPrint(a, "{s}/.claude/projects", .{home});
}

/// `length` bytes from `start` (fewer at the end of the file), decoded lossily like Buffer#toString.
fn readSlice(a: Allocator, file: []const u8, start: u64, length: u64) ![]u8 {
    var handle = try std.Io.Dir.cwd().openFile(cmd.io, file, .{});
    defer handle.close(cmd.io);
    const bytes = try a.alloc(u8, @intCast(length));
    const n = try handle.readPositionalAll(cmd.io, bytes, start);
    return cmd.lossy(a, bytes[0..n]);
}

/// Parsed JSON objects of the lines that start with `{`. The first line is dropped when `drop_first`
/// (the read probably began mid-line); partial lines fail to parse and are skipped.
fn parseLines(a: Allocator, text: []const u8, drop_first: bool) ![]Obj {
    var out: std.ArrayList(Obj) = .empty;
    var lines = std.mem.splitScalar(u8, text, '\n');
    if (drop_first) _ = lines.next();
    while (lines.next()) |line| {
        if (line.len == 0 or line[0] != '{') continue;
        const value = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        switch (value) {
            .object => |o| try out.append(a, o),
            else => {},
        }
    }
    return out.items;
}

fn strOf(o: Obj, key: []const u8) ?[]const u8 {
    const v = o.get(key) orelse return null;
    return switch (v) {
        .string => |s| s,
        else => null,
    };
}

fn isType(o: Obj, ty: []const u8) bool {
    const t = strOf(o, "type") orelse return false;
    return std.mem.eql(u8, t, ty);
}

fn isBlank(s: []const u8) bool {
    return std.mem.trim(u8, s, " \t\r\n\x0b\x0c").len == 0;
}

/// The first prompt the user typed, with injected wrappers (`<…>`, "Caveat:") skipped, whitespace collapsed.
fn userText(a: Allocator, rec: Obj) !?[]const u8 {
    if (!isType(rec, "user")) return null;
    const message = switch (rec.get("message") orelse return null) {
        .object => |o| o,
        else => return null,
    };
    const content = message.get("content") orelse return null;
    const real = struct {
        fn ok(t: []const u8) bool {
            return t.len > 0 and t[0] != '<' and !std.mem.startsWith(u8, t, "Caveat:");
        }
    }.ok;
    var picked: ?[]const u8 = null;
    switch (content) {
        .string => |s| {
            const t = std.mem.trim(u8, s, " \t\r\n\x0b\x0c");
            if (real(t)) picked = t;
        },
        .array => |items| for (items.items) |item| {
            const obj = switch (item) {
                .object => |o| o,
                else => continue,
            };
            if (!std.mem.eql(u8, strOf(obj, "type") orelse "", "text")) continue;
            const t = std.mem.trim(u8, strOf(obj, "text") orelse continue, " \t\r\n\x0b\x0c");
            if (real(t)) {
                picked = t;
                break;
            }
        },
        else => return null,
    }
    const text = picked orelse return null;
    return try collapseWhitespace(a, text);
}

fn collapseWhitespace(a: Allocator, text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var words = std.mem.tokenizeAny(u8, text, " \t\r\n\x0b\x0c");
    var first = true;
    while (words.next()) |word| {
        if (!first) try out.append(a, ' ');
        first = false;
        try out.appendSlice(a, word);
    }
    return out.items;
}

/// The chat's title: the last custom title, else the last summary.
fn findTitle(recs: []const Obj) ?[]const u8 {
    var i = recs.len;
    while (i > 0) {
        i -= 1;
        if (!isType(recs[i], "custom-title")) continue;
        const t = std.mem.trim(u8, strOf(recs[i], "customTitle") orelse continue, " \t\r\n\x0b\x0c");
        if (t.len > 0) return t;
    }
    i = recs.len;
    while (i > 0) {
        i -= 1;
        if (!isType(recs[i], "summary")) continue;
        if (strOf(recs[i], "summary")) |s| return s;
    }
    return null;
}

/// The first `n` characters (code points) of `s`.
fn takeChars(s: []const u8, n: usize) []const u8 {
    var count: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        if (count == n) return s[0..i];
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        i = @min(s.len, i + len);
        count += 1;
    }
    return s;
}

/// "E--softek-core2" → "E:\softek\core2": the lossy fallback when no record carries a cwd.
fn decodeDirName(a: Allocator, d: []const u8) ![]const u8 {
    if (d.len >= 3 and std.ascii.isAlphabetic(d[0]) and std.mem.eql(u8, d[1..3], "--")) {
        const rest = try std.mem.replaceOwned(u8, a, d[3..], "-", "\\");
        return std.fmt.allocPrint(a, "{c}:\\{s}", .{ d[0], rest });
    }
    return d;
}

/// Worktree sessions belong to the repo they were cut from: the part of `cwd` before `/.claude/worktrees/`.
fn projectRoot(cwd: []const u8) []const u8 {
    var i: usize = 0;
    while (i < cwd.len) : (i += 1) {
        if (!isSep(cwd[i])) continue;
        const rest = cwd[i + 1 ..];
        if (rest.len < ".claude/worktrees/".len + 1) continue;
        if (!std.ascii.eqlIgnoreCase(rest[0..8], ".claude/") and !std.ascii.eqlIgnoreCase(rest[0..8], ".claude\\")) continue;
        const after = rest[8..];
        if (after.len < "worktrees".len + 1) continue;
        if (!std.ascii.eqlIgnoreCase(after[0..9], "worktrees")) continue;
        if (!isSep(after[9])) continue;
        return cwd[0..i];
    }
    return cwd;
}

fn isSep(c: u8) bool {
    return c == '/' or c == '\\';
}

/// Path components the way Node's `path` sees them (separators are '/' here).
fn pathParts(a: Allocator, p: []const u8) ![]const []const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeScalar(u8, p, '/');
    while (it.next()) |part| try parts.append(a, part);
    return parts.items;
}

fn baseName(a: Allocator, p: []const u8) ![]const u8 {
    const parts = try pathParts(a, p);
    return if (parts.len == 0) "" else parts[parts.len - 1];
}

fn parentName(a: Allocator, p: []const u8) ![]const u8 {
    const parts = try pathParts(a, p);
    return if (parts.len >= 2) parts[parts.len - 2] else "";
}

fn daysFromCivil(y_in: i64, m: i64, d: i64) i64 {
    const y = if (m <= 2) y_in - 1 else y_in;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const doy = @divFloor(153 * (if (m > 2) m - 3 else m + 9) + 2, 5) + d - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

/// An ISO-8601 date or date-time (as Claude Code writes them) in milliseconds since the epoch; null when unparseable.
fn parseDate(text: []const u8) ?i64 {
    const b = std.mem.trim(u8, text, " \t\r\n\x0b\x0c");
    const num = struct {
        fn at(s: []const u8, from: usize, len: usize) ?i64 {
            if (from + len > s.len) return null;
            var n: i64 = 0;
            for (s[from .. from + len]) |c| {
                if (!std.ascii.isDigit(c)) return null;
                n = n * 10 + (c - '0');
            }
            return n;
        }
    }.at;

    const y = num(b, 0, 4) orelse return null;
    const mo = num(b, 5, 2) orelse return null;
    const d = num(b, 8, 2) orelse return null;
    if (b.len < 10 or b[4] != '-' or b[7] != '-' or mo < 1 or mo > 12 or d < 1 or d > 31) return null;
    const days = daysFromCivil(y, mo, d);
    if (b.len == 10) return days * 86_400_000;
    if (b.len < 16 or !(b[10] == 'T' or b[10] == 't' or b[10] == ' ') or b[13] != ':') return null;
    const h = num(b, 11, 2) orelse return null;
    const mi = num(b, 14, 2) orelse return null;
    var i: usize = 16;
    var sec: i64 = 0;
    var millis: i64 = 0;
    if (i < b.len and b[i] == ':') {
        sec = num(b, i + 1, 2) orelse return null;
        i += 3;
        if (i < b.len and b[i] == '.') {
            i += 1;
            const start = i;
            while (i < b.len and std.ascii.isDigit(b[i])) i += 1;
            if (i == start) return null;
            const frac = b[start..@min(i, start + 3)];
            var v: i64 = 0;
            for (frac) |c| v = v * 10 + (c - '0');
            var scale: usize = 3 - frac.len;
            while (scale > 0) : (scale -= 1) v *= 10;
            millis = v;
        }
    }
    if (h > 24 or mi > 59 or sec > 59) return null;
    var offset_min: i64 = 0;
    if (i < b.len) {
        if ((b[i] == 'Z' or b[i] == 'z') and i + 1 == b.len) {
            offset_min = 0;
        } else if (b[i] == '+' or b[i] == '-') {
            const oh = num(b, i + 1, 2) orelse return null;
            var om: i64 = 0;
            if (i + 3 < b.len and b[i + 3] == ':') {
                if (i + 6 != b.len) return null;
                om = num(b, i + 4, 2) orelse return null;
            } else if (i + 3 < b.len) {
                if (i + 5 != b.len) return null;
                om = num(b, i + 3, 2) orelse return null;
            }
            const off = oh * 60 + om;
            offset_min = if (b[i] == '+') off else -off;
        } else return null;
    }
    return (days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60) * 1000 + millis;
}

fn millisOf(ts: std.Io.Timestamp) i64 {
    return ts.toMilliseconds();
}

/// One session file, read from its head and tail. Null when it holds no conversation and no title.
fn readSession(a: Allocator, file: []const u8, dir_name: []const u8, stat: std.Io.File.Stat) !?SessionInfo {
    const size = stat.size;
    const head_len = @min(head_bytes, size);
    const head = try parseLines(a, try readSlice(a, file, 0, head_len), false);
    const tail: []const Obj = if (size > head_bytes)
        try parseLines(a, try readSlice(a, file, size - @min(tail_bytes, size), @min(tail_bytes, size)), true)
    else
        &.{};

    var cwd: ?[]const u8 = null;
    var first_prompt: ?[]const u8 = null;
    var created: ?i64 = null;
    for (head) |r| {
        if (cwd == null) {
            if (strOf(r, "cwd")) |c| {
                if (c.len > 0) cwd = c;
            }
        }
        if (created == null) {
            if (strOf(r, "timestamp")) |ts| {
                if (parseDate(ts)) |t| {
                    if (t != 0) created = t;
                }
            }
        }
        if (first_prompt == null) first_prompt = try userText(a, r);
        if (cwd != null and first_prompt != null and created != null) break;
    }

    const head_title = findTitle(head);
    const has_head_title = if (head_title) |t| t.len > 0 else false;
    if (first_prompt == null and !has_head_title) return null;

    const title = blk: {
        if (findTitle(tail)) |t| break :blk t;
        if (head_title) |t| break :blk t;
        if (first_prompt) |p| break :blk takeChars(p, 90);
        break :blk "";
    };
    const cwd_value = cwd orelse try decodeDirName(a, dir_name);

    // "updated" is the last real message, not the file's mtime: opening a chat appends bookkeeping records
    const last_source: []const Obj = if (tail.len == 0) head else tail;
    var last_msg: ?i64 = null;
    var i = last_source.len;
    while (i > 0) {
        i -= 1;
        const r = last_source[i];
        if (!isType(r, "user") and !isType(r, "assistant")) continue;
        if (strOf(r, "timestamp")) |ts| {
            if (parseDate(ts)) |t| {
                if (t != 0) {
                    last_msg = t;
                    break;
                }
            }
        }
    }

    const mtime = millisOf(stat.mtime);
    const id = blk: {
        const base = baseNameRaw(file);
        break :blk if (std.mem.lastIndexOfScalar(u8, base, '.')) |dot| base[0..dot] else base;
    };
    return .{
        .id = id,
        .title = title,
        .cwd = cwd_value,
        .projectCwd = projectRoot(cwd_value),
        .created = created orelse mtime,
        .updated = last_msg orelse mtime,
        .cwdExists = pathExists(cwd_value),
    };
}

fn baseNameRaw(path: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, path, '/') orelse return path;
    return path[slash + 1 ..];
}

fn pathExists(path: []const u8) bool {
    _ = std.Io.Dir.cwd().statFile(cmd.io, path, .{}) catch return false;
    return true;
}

fn naturalCmp(a: []const u8, b: []const u8) std.math.Order {
    var x: usize = 0;
    var y: usize = 0;
    while (true) {
        if (x >= a.len and y >= b.len) return .eq;
        if (x >= a.len) return .lt;
        if (y >= b.len) return .gt;
        const c = std.ascii.toLower(a[x]);
        const d = std.ascii.toLower(b[y]);
        if (std.ascii.isDigit(c) and std.ascii.isDigit(d)) {
            var xe = x;
            while (xe < a.len and std.ascii.isDigit(a[xe])) xe += 1;
            var ye = y;
            while (ye < b.len and std.ascii.isDigit(b[ye])) ye += 1;
            const n = std.mem.trimStart(u8, a[x..xe], "0");
            const m = std.mem.trimStart(u8, b[y..ye], "0");
            if (n.len != m.len) return if (n.len < m.len) .lt else .gt;
            const order = std.mem.order(u8, n, m);
            if (order != .eq) return order;
            x = xe;
            y = ye;
        } else {
            if (c != d) return if (c < d) .lt else .gt;
            x += 1;
            y += 1;
        }
    }
}

fn sessionLessNewest(_: void, l: SessionInfo, r: SessionInfo) bool {
    if (l.updated != r.updated) return l.updated > r.updated;
    return std.mem.lessThan(u8, l.id, r.id);
}

/// Every session in the store, grouped by project and sorted by name.
pub fn list(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const root_path = try projectsDir(a);
    var root = std.Io.Dir.cwd().openDir(cmd.io, root_path, .{ .iterate = true }) catch return cmd.json(output, @as([]const ProjectGroup, &.{}));
    defer root.close(cmd.io);

    var sessions: std.ArrayList(SessionInfo) = .empty;
    var dirs = root.iterate();
    while (try dirs.next(cmd.io)) |entry| {
        if (entry.kind != .directory) continue;
        const dir_name = try a.dupe(u8, entry.name);
        const dir_path = try std.fmt.allocPrint(a, "{s}/{s}", .{ root_path, dir_name });
        var sub = std.Io.Dir.cwd().openDir(cmd.io, dir_path, .{ .iterate = true }) catch continue;
        defer sub.close(cmd.io);
        var files = sub.iterate();
        while (try files.next(cmd.io)) |file| {
            if (!std.mem.endsWith(u8, file.name, ".jsonl")) continue;
            const file_path = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir_path, file.name });
            const stat = std.Io.Dir.cwd().statFile(cmd.io, file_path, .{}) catch continue;
            const info = readSession(a, file_path, dir_name, stat) catch continue;
            if (info) |s| try sessions.append(a, s);
        }
    }
    std.mem.sort(SessionInfo, sessions.items, {}, sessionLessNewest);

    var groups: std.ArrayList(ProjectGroup) = .empty;
    for (sessions.items) |s| {
        const key = try lowerTrimmed(a, s.projectCwd);
        var found: ?usize = null;
        for (groups.items, 0..) |g, idx| {
            if (std.mem.eql(u8, g.key, key)) found = idx;
        }
        if (found == null) {
            const name_source = try baseName(a, s.projectCwd);
            try groups.append(a, .{
                .key = key,
                .cwd = s.projectCwd,
                .name = if (name_source.len == 0) s.projectCwd else name_source,
                .updated = 0,
                .sessions = &.{},
            });
            found = groups.items.len - 1;
        }
        const g = &groups.items[found.?];
        g.updated = @max(g.updated, s.updated);
        var list_items: std.ArrayList(SessionInfo) = .empty;
        try list_items.appendSlice(a, g.sessions);
        try list_items.append(a, s);
        g.sessions = list_items.items;
    }
    for (groups.items) |*g| {
        std.mem.sort(SessionInfo, @constCast(g.sessions), {}, sessionLessNewest);
    }

    // two folders with the same name: add the parent folder to tell them apart
    for (groups.items, 0..) |*g, i| {
        var same: usize = 0;
        for (groups.items, 0..) |other, j| {
            if (i != j and std.ascii.eqlIgnoreCase(other.name, g.name)) same += 1;
        }
        if (same == 0) continue;
        const parent = try parentName(a, g.cwd);
        if (parent.len > 0) g.name = try std.fmt.allocPrint(a, "{s} · {s}", .{ g.name, parent });
    }
    std.mem.sort(ProjectGroup, groups.items, {}, struct {
        fn less(_: void, l: ProjectGroup, r: ProjectGroup) bool {
            return naturalCmp(l.name, r.name) == .lt;
        }
    }.less);
    return cmd.json(output, groups.items);
}

fn lowerTrimmed(a: Allocator, s: []const u8) ![]const u8 {
    const lower = try std.ascii.allocLowerString(a, s);
    return std.mem.trimEnd(u8, lower, "\\/");
}

fn writeJson(output: []u8, value: anytype) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try std.json.Stringify.value(value, .{ .emit_null_optional_fields = false }, &writer);
    return writer.buffered();
}

fn validId(id: []const u8) bool {
    if (id.len == 0) return false;
    for (id) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '_' or c == '-')) return false;
    }
    return true;
}

fn findSessionFile(a: Allocator, session_id: []const u8) !?[]const u8 {
    const root_path = try projectsDir(a);
    var root = std.Io.Dir.cwd().openDir(cmd.io, root_path, .{ .iterate = true }) catch return null;
    defer root.close(cmd.io);
    const name = try std.fmt.allocPrint(a, "{s}.jsonl", .{session_id});
    var dirs = root.iterate();
    while (try dirs.next(cmd.io)) |entry| {
        const candidate = try std.fmt.allocPrint(a, "{s}/{s}/{s}", .{ root_path, entry.name, name });
        if (pathExists(candidate)) return candidate;
    }
    return null;
}

fn readWhole(a: Allocator, file: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(cmd.io, file, a, .limited(1024 * 1024 * 1024));
}

fn wholeLines(text: []const u8) []const u8 {
    const end = std.mem.lastIndexOfScalar(u8, text, '\n') orelse return text[0..0];
    return text[0..end];
}

fn objOf(v: ?std.json.Value) ?Obj {
    const value = v orelse return null;
    return switch (value) {
        .object => |o| o,
        else => null,
    };
}

fn arrOf(v: ?std.json.Value) ?[]std.json.Value {
    const value = v orelse return null;
    return switch (value) {
        .array => |arr| arr.items,
        else => null,
    };
}

fn strOr(o: Obj, key: []const u8) []const u8 {
    return strOf(o, key) orelse "";
}

fn numOf(o: Obj, key: []const u8) f64 {
    const v = o.get(key) orelse return 0;
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => 0,
    };
}

fn truthy(v: ?std.json.Value) bool {
    const value = v orelse return false;
    return switch (value) {
        .null => false,
        .bool => |b| b,
        .integer => |i| i != 0,
        .float => |f| f != 0 and !std.math.isNan(f),
        .string => |s| s.len > 0,
        else => true,
    };
}

fn jsString(a: Allocator, v: std.json.Value) ![]const u8 {
    return switch (v) {
        .string => |s| s,
        .null => "null",
        .bool => |b| if (b) "true" else "false",
        .integer => |i| try std.fmt.allocPrint(a, "{d}", .{i}),
        .float => |f| try std.fmt.allocPrint(a, "{d}", .{f}),
        .number_string => |s| s,
        .array => |arr| blk: {
            var out: std.ArrayList(u8) = .empty;
            for (arr.items, 0..) |item, i| {
                if (i > 0) try out.append(a, ',');
                if (item == .null) continue;
                try out.appendSlice(a, try jsString(a, item));
            }
            break :blk out.items;
        },
        .object => "[object Object]",
    };
}

fn coalesce(a: Allocator, o: ?Obj, keys: []const []const u8) ![]const u8 {
    const obj = o orelse return "";
    for (keys) |k| {
        const v = obj.get(k) orelse continue;
        if (v == .null) continue;
        return jsString(a, v);
    }
    return "";
}

fn containsAny(line: []const u8, needles: []const []const u8) bool {
    for (needles) |n| {
        if (std.mem.indexOf(u8, line, n) != null) return true;
    }
    return false;
}

fn timestampOf(row: Obj) i64 {
    const v = row.get("timestamp") orelse return 0;
    const text = switch (v) {
        .string => |s| s,
        else => return 0,
    };
    return parseDate(text) orelse 0;
}

fn contentOf(row: Obj) ?[]std.json.Value {
    const msg = objOf(row.get("message")) orelse return null;
    return arrOf(msg.get("content"));
}

fn imageMime(ext: []const u8) ?[]const u8 {
    if (std.ascii.eqlIgnoreCase(ext, "png")) return "image/png";
    if (std.ascii.eqlIgnoreCase(ext, "jpg") or std.ascii.eqlIgnoreCase(ext, "jpeg")) return "image/jpeg";
    if (std.ascii.eqlIgnoreCase(ext, "gif")) return "image/gif";
    if (std.ascii.eqlIgnoreCase(ext, "webp")) return "image/webp";
    return null;
}

fn mayHoldImage(line: []const u8) bool {
    if (std.mem.indexOf(u8, line, "image") != null) return true;
    for ([_][]const u8{ ".png", ".jpg", ".jpeg", ".gif", ".webp" }) |ext| {
        if (std.ascii.indexOfIgnoreCase(line, ext) != null) return true;
    }
    return false;
}

fn isWordByte(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

fn imageExtAt(text: []const u8, at: usize) ?usize {
    const rest = text[at..];
    for ([_][]const u8{ ".png", ".jpeg", ".jpg", ".gif", ".webp" }) |ext| {
        if (rest.len < ext.len) continue;
        if (!std.ascii.eqlIgnoreCase(rest[0..ext.len], ext)) continue;
        if (rest.len > ext.len and isWordByte(rest[ext.len])) continue;
        return ext.len;
    }
    return null;
}

fn findImagePaths(a: Allocator, text: []const u8, out: *std.ArrayList([]const u8)) !void {
    var i: usize = 0;
    while (i + 3 <= text.len) : (i += 1) {
        if (!std.ascii.isAlphabetic(text[i]) or text[i + 1] != ':' or !isSep(text[i + 2])) continue;
        var end: ?usize = null;
        var j = i + 3;
        while (j < text.len) : (j += 1) {
            const c = text[j];
            if (c == '"' or c == '\'' or c == '\n' or c == '\r' or c == '<' or c == '>' or c == '|' or c == '*' or c == '?') break;
            if (c == '.' and j >= i + 4) {
                if (imageExtAt(text, j)) |len| {
                    end = j + len;
                    break;
                }
            }
        }
        if (end) |e| {
            try out.append(a, text[i..e]);
            i = e - 1;
        }
    }
}

const Found = union(enum) {
    data: []const u8,
    path: []const u8,
};

const ImageWalk = struct {
    a: Allocator,
    found: std.ArrayList(Found) = .empty,
    seen: std.StringHashMap(void),
    total: u64 = 0,

    fn add(self: *ImageWalk, key: []const u8, item: Found) !void {
        const gop = try self.seen.getOrPut(key);
        if (gop.found_existing) return;
        try self.found.append(self.a, item);
        self.total += 1;
        if (self.found.items.len > max_images * 2) {
            const drop = self.found.items.len - max_images;
            std.mem.copyForwards(Found, self.found.items[0 .. self.found.items.len - drop], self.found.items[drop..]);
            self.found.shrinkRetainingCapacity(self.found.items.len - drop);
        }
    }

    fn scanText(self: *ImageWalk, text: []const u8) !void {
        var paths: std.ArrayList([]const u8) = .empty;
        try findImagePaths(self.a, text, &paths);
        for (paths.items) |p| {
            const key = try std.ascii.allocLowerString(self.a, p);
            try self.add(key, .{ .path = p });
        }
    }

    fn walk(self: *ImageWalk, blocks: []std.json.Value, from_user: bool) !void {
        for (blocks) |block| {
            const b = objOf(block) orelse continue;
            const kind = strOr(b, "type");
            if (std.mem.eql(u8, kind, "image")) {
                const src = objOf(b.get("source")) orelse continue;
                if (!std.mem.eql(u8, strOr(src, "type"), "base64")) continue;
                const data = strOf(src, "data") orelse continue;
                if (data.len == 0) continue;
                const key = try std.fmt.allocPrint(self.a, "{s}{d}", .{ data[0..@min(data.len, 200)], data.len });
                const mime = strOf(src, "media_type") orelse "image/png";
                try self.add(key, .{ .data = try std.fmt.allocPrint(self.a, "data:{s};base64,{s}", .{ mime, data }) });
            } else if (std.mem.eql(u8, kind, "tool_result")) {
                if (arrOf(b.get("content"))) |inner| try self.walk(inner, false);
            } else if (std.mem.eql(u8, kind, "text") and from_user) {
                if (strOf(b, "text")) |text| try self.scanText(text);
            }
        }
    }

    fn feed(self: *ImageWalk, text: []const u8) !void {
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line| {
            if (!mayHoldImage(line)) continue;
            const row = std.json.parseFromSliceLeaky(std.json.Value, self.a, line, .{}) catch continue;
            const obj = objOf(row) orelse continue;
            const from_user = std.mem.eql(u8, strOr(obj, "type"), "user");
            const message = objOf(obj.get("message")) orelse continue;
            const content = message.get("content") orelse continue;
            switch (content) {
                .string => |s| if (from_user) try self.scanText(s),
                .array => |items| try self.walk(items.items, from_user),
                else => {},
            }
        }
    }
};

fn pathDataUrl(a: Allocator, p: []const u8) !?[]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, p, '.') orelse return null;
    const mime = imageMime(p[dot + 1 ..]) orelse return null;
    const st = std.Io.Dir.cwd().statFile(cmd.io, p, .{}) catch return null;
    if (st.kind != .file or st.size > max_file_bytes) return null;
    const bytes = std.Io.Dir.cwd().readFileAlloc(cmd.io, p, a, .limited(max_file_bytes)) catch return null;
    const enc = std.base64.standard.Encoder;
    const encoded = try a.alloc(u8, enc.calcSize(bytes.len));
    _ = enc.encode(encoded, bytes);
    return try std.fmt.allocPrint(a, "data:{s};base64,{s}", .{ mime, encoded });
}

const max_images = 40;
const max_file_bytes: u64 = 8 * 1024 * 1024;

/// Every image in a chat, oldest first, as data: URLs. `version` counts the pictures found; with `since`
/// equal to it, `images` is null and nothing is encoded.
pub fn images(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { sessionId: []const u8, since: ?u64 = null }, a, invocation);
    const empty: ?[]const []const u8 = &.{};
    if (!validId(args.sessionId)) return writeJson(output, .{ .version = @as(u64, 0), .images = empty });
    const file = (try findSessionFile(a, args.sessionId)) orelse return writeJson(output, .{ .version = @as(u64, 0), .images = empty });
    const text = readWhole(a, file) catch return writeJson(output, .{ .version = @as(u64, 0), .images = empty });

    var walk: ImageWalk = .{ .a = a, .seen = std.StringHashMap(void).init(a) };
    try walk.feed(wholeLines(text));
    if (args.since) |since| {
        if (since == walk.total) return writeJson(output, .{ .version = walk.total, .images = @as(?[]const []const u8, null) });
    }

    var out: std.ArrayList([]const u8) = .empty;
    const start = walk.found.items.len -| max_images;
    for (walk.found.items[start..]) |item| {
        switch (item) {
            .data => |d| try out.append(a, d),
            .path => |p| if (try pathDataUrl(a, p)) |url| try out.append(a, url),
        }
    }
    return writeJson(output, .{ .version = walk.total, .images = @as(?[]const []const u8, out.items) });
}

const ContextOut = struct {
    used: u64,
    model: []const u8,
};

fn sessionContext(a: Allocator, session_id: []const u8) !?ContextOut {
    if (!validId(session_id)) return null;
    const file = (try findSessionFile(a, session_id)) orelse return null;
    const size = (try std.Io.Dir.cwd().statFile(cmd.io, file, .{})).size;
    const spans = [_]u64{ 256 * 1024, 4 * 1024 * 1024, size };
    for (spans) |span| {
        const start = size -| span;
        const rows = try parseLines(a, try readSlice(a, file, start, size - start), start > 0);
        var i = rows.len;
        while (i > 0) {
            i -= 1;
            const r = rows[i];
            if (!isType(r, "assistant") or truthy(r.get("isSidechain")) or truthy(r.get("isApiErrorMessage"))) continue;
            const msg = objOf(r.get("message")) orelse continue;
            const model = strOf(msg, "model");
            if (model) |m| {
                if (std.mem.eql(u8, m, "<synthetic>")) continue;
            }
            const usage = objOf(msg.get("usage")) orelse continue;
            const used = numOf(usage, "input_tokens") + numOf(usage, "cache_read_input_tokens") + numOf(usage, "cache_creation_input_tokens") + numOf(usage, "output_tokens");
            if (used > 0) return .{ .used = @intFromFloat(used), .model = model orelse "" };
        }
        if (start == 0) break;
    }
    return null;
}

/// How full a chat's context window is: the token count of the last main-thread API call, from the tail of its session file.
pub fn context(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { sessionId: []const u8 }, a, invocation);
    const found = sessionContext(a, args.sessionId) catch null;
    return writeJson(output, found);
}

const ChatTaskOut = struct {
    id: []const u8,
    command: []const u8,
    description: []const u8,
    status: []const u8,
    startedAt: i64,
    endedAt: ?i64 = null,
    outputFile: ?[]const u8 = null,
    output: ?[]const u8 = null,
};

const TaskCall = struct {
    command: []const u8,
    description: []const u8,
};

const EndInfo = struct {
    status: []const u8,
    at: i64,
};

const Notice = struct {
    id: []const u8,
    status: []const u8,
    end: usize,
};

fn findNotice(text: []const u8, from: usize) ?Notice {
    const open_id = "<task-id>";
    const close_id = "</task-id>";
    const open_status = "<status>";
    const close_status = "</status>";
    var pos = from;
    while (std.mem.indexOfPos(u8, text, pos, open_id)) |open| {
        const id_start = open + open_id.len;
        pos = open + 1;
        const id_end = std.mem.indexOfScalarPos(u8, text, id_start, '<') orelse continue;
        if (id_end == id_start or !std.mem.startsWith(u8, text[id_end..], close_id)) continue;
        var after = id_end + close_id.len;
        while (std.mem.indexOfPos(u8, text, after, open_status)) |s_open| {
            const st_start = s_open + open_status.len;
            const st_end = std.mem.indexOfScalarPos(u8, text, st_start, '<') orelse break;
            if (st_end > st_start and std.mem.startsWith(u8, text[st_end..], close_status)) {
                return .{ .id = text[id_start..id_end], .status = text[st_start..st_end], .end = st_end + close_status.len };
            }
            after = s_open + 1;
        }
    }
    return null;
}

fn outputFileOf(msg: []const u8) ?[]const u8 {
    const marker = "Output is being written to: ";
    var pos: usize = 0;
    while (std.mem.indexOfPos(u8, msg, pos, marker)) |m| {
        const start = m + marker.len;
        var end: ?usize = null;
        var j = start;
        while (j < msg.len) : (j += 1) {
            const c = msg[j];
            const line_break = c == '\n' or c == '\r' or (c == 0xE2 and j + 2 < msg.len and msg[j + 1] == 0x80 and (msg[j + 2] == 0xA8 or msg[j + 2] == 0xA9));
            if (line_break) break;
            if (c == '.' and j >= start + 1 and std.mem.startsWith(u8, msg[j..], ".output")) {
                end = j + ".output".len;
                break;
            }
        }
        if (end) |e| return msg[start..e];
        pos = m + 1;
    }
    return null;
}

fn stripAnsi(a: Allocator, text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        if (text[i] == 0x1b and i + 1 < text.len and text[i + 1] == '[') {
            var j = i + 2;
            while (j < text.len and (std.ascii.isDigit(text[j]) or text[j] == ';')) j += 1;
            if (j < text.len and text[j] == 'm') {
                i = j + 1;
                continue;
            }
        }
        try out.append(a, text[i]);
        i += 1;
    }
    return out.items;
}

fn scanTasks(
    a: Allocator,
    text: []const u8,
    calls: *std.StringHashMap(TaskCall),
    tasks: *std.ArrayList(ChatTaskOut),
    index: *std.StringHashMap(usize),
    ended: *std.StringHashMap(EndInfo),
) !void {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!containsAny(line, &.{ "run_in_background", "backgroundTaskId", "<task-notification>" })) continue;
        const row_value = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        const row = objOf(row_value) orelse continue;
        const at = timestampOf(row);
        const content = contentOf(row);

        if (isType(row, "assistant")) {
            if (content) |items| {
                for (items) |item| {
                    const b = objOf(item) orelse continue;
                    if (!isType(b, "tool_use")) continue;
                    const id = strOf(b, "id") orelse continue;
                    if (id.len == 0) continue;
                    const input = objOf(b.get("input"));
                    const background = if (input) |i| truthy(i.get("run_in_background")) else false;
                    if (!background) continue;
                    try calls.put(id, .{
                        .command = try coalesce(a, input, &.{ "command", "prompt" }),
                        .description = try coalesce(a, input, &.{"description"}),
                    });
                }
            }
        }

        const tur = objOf(row.get("toolUseResult"));
        const task_id = if (tur) |t| strOf(t, "backgroundTaskId") else null;
        if (task_id) |tid| {
            if (tid.len > 0) {
                if (content) |items| {
                    var result: ?Obj = null;
                    for (items) |item| {
                        const b = objOf(item) orelse continue;
                        if (isType(b, "tool_result")) {
                            result = b;
                            break;
                        }
                    }
                    const msg: []const u8 = blk: {
                        const value = if (result) |r| r.get("content") else null;
                        const v = value orelse break :blk "\"\"";
                        switch (v) {
                            .null => break :blk "\"\"",
                            .string => |s| break :blk s,
                            else => break :blk try std.json.Stringify.valueAlloc(a, v, .{}),
                        }
                    };
                    const tool_id = if (result) |r| strOr(r, "tool_use_id") else "";
                    const call = calls.get(tool_id);
                    const task: ChatTaskOut = .{
                        .id = tid,
                        .command = if (call) |c| c.command else "",
                        .description = if (call) |c| c.description else "",
                        .status = "running",
                        .startedAt = at,
                        .outputFile = outputFileOf(msg),
                    };
                    if (index.get(tid)) |i| {
                        tasks.items[i] = task;
                    } else {
                        try index.put(tid, tasks.items.len);
                        try tasks.append(a, task);
                    }
                }
            }
        }

        const note = strOf(row, "content") orelse line;
        var pos: usize = 0;
        while (findNotice(note, pos)) |n| {
            const gop = try ended.getOrPut(n.id);
            if (!gop.found_existing) gop.value_ptr.* = .{ .status = n.status, .at = at };
            pos = n.end;
        }
    }
}

fn sessionTasks(a: Allocator, session_id: []const u8) ![]ChatTaskOut {
    if (!validId(session_id)) return &.{};
    const file = (try findSessionFile(a, session_id)) orelse return &.{};
    const text = try readWhole(a, file);
    var calls = std.StringHashMap(TaskCall).init(a);
    var tasks: std.ArrayList(ChatTaskOut) = .empty;
    var index = std.StringHashMap(usize).init(a);
    var ended = std.StringHashMap(EndInfo).init(a);
    try scanTasks(a, wholeLines(text), &calls, &tasks, &index, &ended);
    std.mem.reverse(ChatTaskOut, tasks.items);
    for (tasks.items) |*t| {
        if (ended.get(t.id)) |e| {
            t.status = e.status;
            t.endedAt = e.at;
        }
        const out_file = t.outputFile orelse continue;
        const st = std.Io.Dir.cwd().statFile(cmd.io, out_file, .{}) catch continue;
        const start = st.size -| 6000;
        const tail = readSlice(a, out_file, start, 6000) catch continue;
        t.output = try stripAnsi(a, tail);
    }
    return tasks.items;
}

/// Background tasks Claude started in a chat, with their status from the task notifications and the end of their output.
pub fn chatTasks(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { sessionId: []const u8 }, a, invocation);
    const found = sessionTasks(a, args.sessionId) catch &.{};
    return writeJson(output, found);
}

const SubAgentOut = struct {
    id: []const u8,
    kind: []const u8,
    description: []const u8,
    status: []const u8,
    startedAt: i64,
    endedAt: ?i64 = null,
};

fn scanSubagents(a: Allocator, text: []const u8, agents: *std.ArrayList(SubAgentOut), index: *std.StringHashMap(usize)) !void {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!containsAny(line, &.{ "\"Agent\"", "\"Task\"", "tool_use_id" })) continue;
        const row_value = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        const row = objOf(row_value) orelse continue;
        const at = timestampOf(row);
        const content = contentOf(row) orelse continue;
        for (content) |item| {
            const b = objOf(item) orelse continue;
            const name = strOr(b, "name");
            if (isType(b, "tool_use") and (std.mem.eql(u8, name, "Agent") or std.mem.eql(u8, name, "Task"))) {
                const id = strOf(b, "id") orelse continue;
                if (id.len == 0) continue;
                const input = objOf(b.get("input"));
                const kind = try coalesce(a, input, &.{"subagent_type"});
                try index.put(id, agents.items.len);
                try agents.append(a, .{
                    .id = id,
                    .kind = if (kind.len == 0) "general-purpose" else kind,
                    .description = try coalesce(a, input, &.{"description"}),
                    .status = "running",
                    .startedAt = at,
                });
            } else if (isType(b, "tool_result")) {
                const tid = strOf(b, "tool_use_id") orelse continue;
                const i = index.get(tid) orelse continue;
                agents.items[i].status = if (truthy(b.get("is_error"))) "failed" else "completed";
                agents.items[i].endedAt = at;
            }
        }
    }
}

/// The sub-agents a chat's Claude started (Agent or Task tool), oldest first.
pub fn subagents(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { sessionId: []const u8 }, a, invocation);
    var agents: std.ArrayList(SubAgentOut) = .empty;
    if (validId(args.sessionId)) {
        if (try findSessionFile(a, args.sessionId)) |file| {
            if (readWhole(a, file)) |text| {
                var index = std.StringHashMap(usize).init(a);
                try scanSubagents(a, wholeLines(text), &agents, &index);
            } else |_| {}
        }
    }
    return writeJson(output, agents.items);
}

const FileEditOut = struct {
    id: []const u8,
    tool: []const u8,
    old: []const u8,
    new: []const u8,
    whole: bool,
    at: i64,
};

const SessionFileOut = struct {
    path: []const u8,
    edits: []const FileEditOut,
};

const ChangeEntry = struct {
    tool_id: []const u8,
    path: []const u8,
    edit: FileEditOut,
};

fn scanChanges(
    a: Allocator,
    text: []const u8,
    entries: *std.ArrayList(ChangeEntry),
    failed: *std.StringHashMap(void),
) !void {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!containsAny(line, &.{ "\"Edit\"", "\"Write\"", "\"MultiEdit\"", "tool_use_id" })) continue;
        const row_value = std.json.parseFromSliceLeaky(std.json.Value, a, line, .{}) catch continue;
        const row = objOf(row_value) orelse continue;
        const at = timestampOf(row);
        const content = contentOf(row) orelse continue;
        for (content) |item| {
            const b = objOf(item) orelse continue;
            if (isType(b, "tool_use")) {
                const input = objOf(b.get("input")) orelse continue;
                const tool = strOr(b, "name");
                const id = strOf(b, "id") orelse continue;
                if (id.len == 0) continue;
                const path = strOf(input, "file_path") orelse continue;
                if (path.len == 0) continue;
                if (std.mem.eql(u8, tool, "Edit")) {
                    try entries.append(a, .{ .tool_id = id, .path = path, .edit = .{
                        .id = id,
                        .tool = tool,
                        .old = strOr(input, "old_string"),
                        .new = strOr(input, "new_string"),
                        .whole = false,
                        .at = at,
                    } });
                } else if (std.mem.eql(u8, tool, "Write")) {
                    try entries.append(a, .{ .tool_id = id, .path = path, .edit = .{
                        .id = id,
                        .tool = tool,
                        .old = "",
                        .new = strOr(input, "content"),
                        .whole = true,
                        .at = at,
                    } });
                } else if (std.mem.eql(u8, tool, "MultiEdit")) {
                    const edits = arrOf(input.get("edits")) orelse &.{};
                    for (edits, 0..) |e, i| {
                        const eo = objOf(e) orelse continue;
                        try entries.append(a, .{ .tool_id = id, .path = path, .edit = .{
                            .id = try std.fmt.allocPrint(a, "{s}#{d}", .{ id, i }),
                            .tool = tool,
                            .old = strOr(eo, "old_string"),
                            .new = strOr(eo, "new_string"),
                            .whole = false,
                            .at = at,
                        } });
                    }
                }
            } else if (isType(b, "tool_result") and truthy(b.get("is_error"))) {
                if (strOf(b, "tool_use_id")) |tid| try failed.put(tid, {});
            }
        }
    }
}

/// The files a chat's Claude edited with Edit, MultiEdit or Write, in the order each file was first touched.
pub fn changes(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { sessionId: []const u8 }, a, invocation);

    var files: std.ArrayList(SessionFileOut) = .empty;
    if (validId(args.sessionId)) {
        if (try findSessionFile(a, args.sessionId)) |file| {
            if (readWhole(a, file)) |text| {
                var entries: std.ArrayList(ChangeEntry) = .empty;
                var failed = std.StringHashMap(void).init(a);
                try scanChanges(a, wholeLines(text), &entries, &failed);
                var lists: std.ArrayList(std.ArrayList(FileEditOut)) = .empty;
                var index = std.StringHashMap(usize).init(a);
                for (entries.items) |e| {
                    if (failed.contains(e.tool_id)) continue;
                    const gop = try index.getOrPut(e.path);
                    if (!gop.found_existing) {
                        gop.value_ptr.* = files.items.len;
                        try files.append(a, .{ .path = e.path, .edits = &.{} });
                        try lists.append(a, .empty);
                    }
                    try lists.items[gop.value_ptr.*].append(a, e.edit);
                }
                for (files.items, 0..) |*f, i| f.edits = lists.items[i].items;
            } else |_| {}
        }
    }
    return writeJson(output, files.items);
}
