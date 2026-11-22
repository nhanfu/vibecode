//! The file watcher behind the explorer, editor and Changes panel. Port of fs_watch in src-tauri/src/fsx.rs.
//!
//! inotify (Linux) on a thread: events are queued under a mutex, and a GLib idle callback, which runs on
//! the GTK thread, sends them to the page. The page's own thread is never touched from the watcher.
//! Renamed/recursive folder watches are added as folders appear; `.git` and `node_modules` are skipped
//! for file events, and changes under `.git` raise `git:changed`.

const std = @import("std");
const linux = std.os.linux;
const cmd = @import("root.zig");

extern fn g_idle_add(function: *const fn (?*anyopaque) callconv(.c) c_int, data: ?*anyopaque) c_uint;

const max_watches: usize = 8192;
const event_mask = linux.IN.CREATE | linux.IN.DELETE | linux.IN.MODIFY | linux.IN.MOVED_FROM | linux.IN.MOVED_TO | linux.IN.CLOSE_WRITE | linux.IN.ATTRIB | linux.IN.DELETE_SELF | linux.IN.MOVE_SELF;

var mutex: std.Io.Mutex = .init;
var generation: u32 = 0;
var inotify_fd: i32 = -1;
var root_path: []u8 = &.{};
var watched: std.AutoHashMap(i32, []u8) = undefined;
var watched_ready = false;
var pending_files: std.ArrayList([]u8) = .empty;
var pending_git = false;
var pending_lost = false;
var idle_scheduled = false;

/// Stops the current watch (if any) and starts watching `root`; null just stops it.
pub fn watch(root: ?[]const u8) !void {
    stop();
    const dir = root orelse return;
    const fd = try initInotify();
    const root_copy = try cmd.gpa.dupe(u8, dir);
    mutex.lockUncancelable(cmd.io);
    generation += 1;
    const gen = generation;
    inotify_fd = fd;
    root_path = root_copy;
    mutex.unlock(cmd.io);

    try addRecursive(dir);
    const thread = try std.Thread.spawn(.{}, run, .{ gen, fd });
    thread.detach();
}

fn initInotify() !i32 {
    const rc = linux.inotify_init1(linux.IN.CLOEXEC | linux.IN.NONBLOCK);
    if (linux.errno(rc) != .SUCCESS) return error.InotifyFailed;
    return @intCast(rc);
}

fn stop() void {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    generation += 1;
    if (inotify_fd >= 0) {
        _ = linux.close(inotify_fd);
        inotify_fd = -1;
    }
    // the old root and folder paths are not freed here: the old thread may still be reading them
    // (a few bytes per restart)
    if (watched_ready) {
        watched.clearRetainingCapacity();
    }
}

fn ensureMap() void {
    if (!watched_ready) {
        watched = std.AutoHashMap(i32, []u8).init(cmd.gpa);
        watched_ready = true;
    }
}

/// Adds a watch on `dir` and on every folder below it, except the ones we never report.
fn addRecursive(dir: []const u8) !void {
    try addWatch(dir);
    var d = std.Io.Dir.cwd().openDir(cmd.io, dir, .{ .iterate = true }) catch return;
    defer d.close(cmd.io);
    var it = d.iterate();
    while (try it.next(cmd.io)) |entry| {
        if (entry.kind != .directory or skipped(entry.name)) continue;
        const child = try std.fs.path.join(cmd.gpa, &.{ dir, entry.name });
        defer cmd.gpa.free(child);
        try addRecursive(child);
    }
}

fn addWatch(dir: []const u8) !void {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    ensureMap();
    if (watched.count() >= max_watches) return;
    const z = try cmd.gpa.dupeZ(u8, dir);
    defer cmd.gpa.free(z);
    const rc = linux.inotify_add_watch(inotify_fd, z.ptr, event_mask);
    if (linux.errno(rc) != .SUCCESS) return;
    const wd: i32 = @intCast(rc);
    if (watched.fetchRemove(wd)) |old| cmd.gpa.free(old.value);
    try watched.put(wd, try cmd.gpa.dupe(u8, dir));
}

fn skipped(name: []const u8) bool {
    return std.mem.eql(u8, name, "node_modules");
}

fn run(gen: u32, fd: i32) void {
    var buffer: [16384]u8 align(@alignOf(linux.inotify_event)) = undefined;
    while (true) {
        const rc = linux.read(fd, &buffer, buffer.len);
        switch (linux.errno(rc)) {
            .SUCCESS => {},
            .INTR, .AGAIN => {
                if (!stillCurrent(gen)) return;
                std.Io.sleep(cmd.io, std.Io.Duration.fromMilliseconds(50), .real) catch {};
                continue;
            },
            else => return,
        }
        if (!stillCurrent(gen)) return;
        const n: usize = rc;
        var offset: usize = 0;
        while (offset + @sizeOf(linux.inotify_event) <= n) {
            const event: *align(1) linux.inotify_event = @ptrCast(&buffer[offset]);
            const name_start = offset + @sizeOf(linux.inotify_event);
            const name_end = name_start + event.len;
            const name_raw = buffer[name_start..@min(name_end, n)];
            const name = std.mem.sliceTo(name_raw, 0);
            offset = name_end;
            handle(event.wd, event.mask, name);
        }
    }
}

fn stillCurrent(gen: u32) bool {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    return gen == generation;
}

fn handle(wd: i32, mask: u32, name: []const u8) void {
    if (mask & linux.IN.Q_OVERFLOW != 0) {
        queueLost();
        return;
    }
    mutex.lockUncancelable(cmd.io);
    const parent_copy: ?[]u8 = if (watched_ready)
        (if (watched.get(wd)) |dir| cmd.gpa.dupe(u8, dir) catch null else null)
    else
        null;
    const root_copy: []u8 = if (root_path.len > 0) cmd.gpa.dupe(u8, root_path) catch &.{} else &.{};
    mutex.unlock(cmd.io);
    const parent = parent_copy orelse return;
    defer cmd.gpa.free(parent);
    defer if (root_copy.len > 0) cmd.gpa.free(root_copy);
    const root = root_copy;

    const path = std.fs.path.join(cmd.gpa, &.{ parent, name }) catch return;
    defer cmd.gpa.free(path);

    if (mask & linux.IN.ISDIR != 0 and mask & (linux.IN.CREATE | linux.IN.MOVED_TO) != 0 and !skipped(name)) {
        addRecursive(path) catch {};
    }
    if (mask & linux.IN.ISDIR != 0 and name.len > 0 and std.mem.eql(u8, name, ".git")) {
        queueGit();
        return;
    }
    const rel = if (std.mem.startsWith(u8, path, root)) path[root.len..] else path;
    if (std.mem.indexOf(u8, rel, "/.git/") != null or std.mem.endsWith(u8, rel, "/.git")) {
        queueGit();
        return;
    }
    if (std.mem.indexOf(u8, rel, "/node_modules/") != null) return;
    queueFile(path);
}

fn queueFile(path: []const u8) void {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    const copy = cmd.gpa.dupe(u8, path) catch return;
    pending_files.append(cmd.gpa, copy) catch {
        cmd.gpa.free(copy);
        return;
    };
    scheduleLocked();
}

fn queueGit() void {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    pending_git = true;
    scheduleLocked();
}

fn queueLost() void {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    pending_lost = true;
    scheduleLocked();
}

fn scheduleLocked() void {
    if (idle_scheduled) return;
    idle_scheduled = true;
    _ = g_idle_add(flush, null);
}

/// Runs on the GTK thread: sends what the watcher queued since the last flush.
fn flush(_: ?*anyopaque) callconv(.c) c_int {
    mutex.lockUncancelable(cmd.io);
    const files = pending_files;
    const git = pending_git;
    const lost = pending_lost;
    const root = root_path;
    pending_files = .empty;
    pending_git = false;
    pending_lost = false;
    idle_scheduled = false;
    mutex.unlock(cmd.io);

    defer {
        for (files.items) |p| cmd.gpa.free(p);
        var owned = files;
        owned.deinit(cmd.gpa);
    }

    if (lost) {
        sendFiles(&.{root});
        cmd.emit("git:changed", "[]");
        return 0;
    }
    if (files.items.len > 0) sendFiles(files.items);
    if (git) cmd.emit("git:changed", "[]");
    return 0;
}

fn sendFiles(paths: []const []const u8) void {
    var a = std.heap.ArenaAllocator.init(cmd.gpa);
    defer a.deinit();
    const json = std.json.Stringify.valueAlloc(a.allocator(), .{paths}, .{}) catch return;
    cmd.emit("fs:changed", json);
}

/// `{ root }`: watches the open folder (null stops the watch). Port of fs_watch.
pub fn fsWatch(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { root: ?[]const u8 = null }, a, invocation);
    watch(args.root) catch |err| return cmd.fail(output, @errorName(err));
    return cmd.json(output, null);
}
