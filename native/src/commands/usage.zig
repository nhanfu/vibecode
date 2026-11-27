const std = @import("std");
const cmd = @import("root.zig");

const Limit = struct {
    kind: []const u8,
    label: []const u8,
    percent: i64,
    severity: []const u8,
    resetsAt: ?[]const u8,
};

fn stringField(object: std.json.ObjectMap, key: []const u8) []const u8 {
    const value = object.get(key) orelse return "";
    return switch (value) {
        .string => |s| s,
        else => "",
    };
}

fn numberField(object: std.json.ObjectMap, key: []const u8) f64 {
    const value = object.get(key) orelse return 0;
    return switch (value) {
        .float => |f| f,
        .integer => |i| @floatFromInt(i),
        else => 0,
    };
}

fn modelName(object: std.json.ObjectMap) ?[]const u8 {
    const scope = object.get("scope") orelse return null;
    if (scope != .object) return null;
    const model = scope.object.get("model") orelse return null;
    if (model != .object) return null;
    const name = stringField(model.object, "display_name");
    return if (name.len == 0) null else name;
}

fn fetchUsage(a: std.mem.Allocator) !?[]Limit {
    const home = std.mem.span(std.c.getenv("HOME") orelse return null);
    const creds_path = try std.fmt.allocPrint(a, "{s}/.claude/.credentials.json", .{home});
    const raw = try std.Io.Dir.cwd().readFileAlloc(cmd.io, creds_path, a, .limited(1024 * 1024));
    const creds = try std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{});
    const token_value = creds.object.get("claudeAiOauth") orelse return null;
    if (token_value != .object) return null;
    const token = stringField(token_value.object, "accessToken");
    if (token.len == 0) return null;

    const bearer = try std.fmt.allocPrint(a, "Bearer {s}", .{token});
    var client: std.http.Client = .{ .allocator = cmd.gpa, .io = cmd.io };
    defer client.deinit();
    var body: std.Io.Writer.Allocating = .init(a);
    const result = try client.fetch(.{
        .location = .{ .url = "https://api.anthropic.com/api/oauth/usage" },
        .method = .GET,
        .extra_headers = &.{
            .{ .name = "Authorization", .value = bearer },
            .{ .name = "anthropic-beta", .value = "oauth-2025-04-20" },
        },
        .response_writer = &body.writer,
    });
    if (result.status != .ok) return null;

    const json = try std.json.parseFromSliceLeaky(std.json.Value, a, body.written(), .{});
    if (json != .object) return null;
    const limits_value = json.object.get("limits") orelse return null;
    if (limits_value != .array) return null;

    var out: std.ArrayList(Limit) = .empty;
    for (limits_value.array.items) |item| {
        if (item != .object) continue;
        const object = item.object;
        const kind = stringField(object, "kind");
        const label = if (std.mem.eql(u8, kind, "session"))
            "5-hour"
        else if (std.mem.eql(u8, kind, "weekly_all"))
            "Weekly"
        else
            try std.fmt.allocPrint(a, "Weekly · {s}", .{modelName(object) orelse "model"});
        const resets = stringField(object, "resets_at");
        try out.append(a, .{
            .kind = kind,
            .label = label,
            .percent = @intFromFloat(@round(numberField(object, "percent"))),
            .severity = stringField(object, "severity"),
            .resetsAt = if (resets.len == 0) null else resets,
        });
    }
    return out.items;
}

/// The last limits that came back, kept in the app's memory (the API answers 429 when asked too often, and
/// a failed call must not blank the meters). Asked for again at most once a minute.
var cache: ?[]Limit = null;
var cache_at_ns: i128 = 0;
const refresh_ns: i128 = 60 * std.time.ns_per_s;

fn monotonicNs() i128 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(.MONOTONIC, &ts);
    return @as(i128, ts.sec) * std.time.ns_per_s + ts.nsec;
}

/// A copy owned by the app's allocator (the call's arena goes away).
fn cloneLimits(limits: []const Limit) ![]Limit {
    const out = try cmd.gpa.alloc(Limit, limits.len);
    for (limits, out) |l, *o| {
        o.* = .{
            .kind = try cmd.gpa.dupe(u8, l.kind),
            .label = try cmd.gpa.dupe(u8, l.label),
            .percent = l.percent,
            .severity = try cmd.gpa.dupe(u8, l.severity),
            .resetsAt = if (l.resetsAt) |r| try cmd.gpa.dupe(u8, r) else null,
        };
    }
    return out;
}

pub fn claudeUsage(_: cmd.Invocation, output: []u8) ![]const u8 {
    const now = monotonicNs();
    if (cache == null or now - cache_at_ns >= refresh_ns) {
        cache_at_ns = now;
        var arena = std.heap.ArenaAllocator.init(cmd.gpa);
        defer arena.deinit();
        if (fetchUsage(arena.allocator()) catch null) |fresh| {
            cache = cloneLimits(fresh) catch cache;
        }
    }
    return cmd.json(output, cache);
}
