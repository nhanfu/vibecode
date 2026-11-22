//! The Claude Code session store (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`), read for the
//! session list. Port of the list half of src-tauri/src/sessions.rs: the per-session caches, the file
//! watcher and the chat detail commands (images, context, tasks, subagents, changes) are not ported yet.
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
