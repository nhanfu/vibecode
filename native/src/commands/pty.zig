
const std = @import("std");
const cmd = @import("root.zig");
const ptyd = @import("ptyd.zig");
const openreq = @import("openreq.zig");

extern "c" fn usleep(usec: c_uint) c_int;

const agents = [_]struct { id: []const u8, command: []const u8 }{
    .{ .id = "claude", .command = "claude" },
    .{ .id = "codex", .command = "codex" },
    .{ .id = "grok", .command = "grok" },
    .{ .id = "gemini", .command = "gemini" },
    .{ .id = "qwen", .command = "qwen" },
    .{ .id = "copilot", .command = "copilot" },
    .{ .id = "opencode", .command = "opencode" },
};

fn agentCommand(id: ?[]const u8) []const u8 {
    const wanted = id orelse "claude";
    for (agents) |agent| {
        if (std.mem.eql(u8, agent.id, wanted)) return agent.command;
    }
    return "claude";
}

fn quoteArg(a: std.mem.Allocator, arg: []const u8) ![]const u8 {
    var plain = arg.len > 0;
    for (arg) |c| {
        if (!(std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_-./:=", c) != null)) plain = false;
    }
    if (plain) return arg;
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, '\'');
    for (arg) |c| {
        if (c == '\'') {
            try out.appendSlice(a, "'\\''");
        } else {
            try out.append(a, c);
        }
    }
    try out.append(a, '\'');
    return out.items;
}

const Session = struct {
    id: []u8,
    outbox: std.ArrayList(u8) = .empty,
    exited: bool = false,
    exit_code: i32 = 0,
};

var mutex: std.Io.Mutex = .init;
var write_mutex: std.Io.Mutex = .init;
var sessions: std.ArrayList(*Session) = .empty;
var daemon_fd: ?c_int = null;
var flush_scheduled = false;

extern fn g_idle_add(function: *const fn (?*anyopaque) callconv(.c) c_int, data: ?*anyopaque) c_uint;

fn lockState() void {
    mutex.lockUncancelable(cmd.io);
}

fn unlockState() void {
    mutex.unlock(cmd.io);
}

fn findLocked(id: []const u8) ?*Session {
    for (sessions.items) |s| {
        if (std.mem.eql(u8, s.id, id)) return s;
    }
    return null;
}

fn newSessionLocked(id: []const u8) !*Session {
    const s = try cmd.gpa.create(Session);
    s.* = .{ .id = try cmd.gpa.dupe(u8, id) };
    try sessions.append(cmd.gpa, s);
    return s;
}

fn destroyLocked(s: *Session) void {
    for (sessions.items, 0..) |item, i| {
        if (item == s) {
            _ = sessions.swapRemove(i);
            break;
        }
    }
    s.outbox.deinit(cmd.gpa);
    cmd.gpa.free(s.id);
    cmd.gpa.destroy(s);
}

fn scheduleLocked() void {
    if (flush_scheduled) return;
    flush_scheduled = true;
    _ = g_idle_add(flush, null);
}

fn appendLocked(s: *Session, bytes: []const u8) void {
    s.outbox.appendSlice(cmd.gpa, bytes) catch {};
    scheduleLocked();
}

fn connectDaemon() ?c_int {
    lockState();
    if (daemon_fd) |fd| {
        unlockState();
        return fd;
    }
    unlockState();

    const path = ptyd.socketPath() orelse return null;
    var fd = ptyd.connectSocket(path);
    if (fd == null) {
        startDaemon();
        var attempt: usize = 0;
        while (attempt < 60 and fd == null) : (attempt += 1) {
            _ = usleep(50_000);
            fd = ptyd.connectSocket(path);
        }
    }
    const connected = fd orelse return null;

    lockState();
    if (daemon_fd) |existing| {
        unlockState();
        _ = std.c.close(connected);
        return existing;
    }
    daemon_fd = connected;
    unlockState();

    const thread = std.Thread.spawn(.{}, readDaemon, .{connected}) catch {
        lockState();
        daemon_fd = null;
        unlockState();
        _ = std.c.close(connected);
        return null;
    };
    thread.detach();
    return connected;
}

fn currentDaemon() ?c_int {
    lockState();
    defer unlockState();
    return daemon_fd;
}

fn startDaemon() void {
    var self_path: [4096]u8 = undefined;
    const n = std.c.readlink("/proc/self/exe", &self_path, self_path.len - 1);
    if (n <= 0) return;
    self_path[@intCast(n)] = 0;
    const exe: [*:0]const u8 = @ptrCast(&self_path);

    const first = std.c.fork();
    if (first < 0) return;
    if (first == 0) {
        _ = std.c.setsid();
        if (std.c.fork() == 0) {
            _ = std.c.close(0);
            _ = std.c.close(1);
            _ = std.c.close(2);
            const argv = [_:null]?[*:0]const u8{ exe, "--ptyd" };
            _ = std.c.execve(exe, &argv, @ptrCast(std.c.environ));
        }
        std.c._exit(0);
    }
    var status: c_int = 0;
    _ = std.c.waitpid(first, &status, 0);
}

fn sendFrame(kind: u8, body: []const u8) bool {
    const fd = connectDaemon() orelse return false;
    const bytes = ptyd.frame(cmd.gpa, kind, body) catch return false;
    defer cmd.gpa.free(bytes);
    write_mutex.lockUncancelable(cmd.io);
    defer write_mutex.unlock(cmd.io);
    return ptyd.writeAll(fd, bytes);
}

fn sendToLive(kind: u8, body: []const u8) bool {
    const fd = currentDaemon() orelse return false;
    const bytes = ptyd.frame(cmd.gpa, kind, body) catch return false;
    defer cmd.gpa.free(bytes);
    write_mutex.lockUncancelable(cmd.io);
    defer write_mutex.unlock(cmd.io);
    return ptyd.writeAll(fd, bytes);
}

fn readDaemon(fd: c_int) void {
    while (ptyd.readFrame(cmd.gpa, fd)) |f| {
        defer cmd.gpa.free(f.body);
        onFrame(f.kind, f.body);
    } else |_| {}
    lockState();
    if (daemon_fd == fd) daemon_fd = null;
    for (sessions.items) |s| {
        if (!s.exited) {
            s.exited = true;
            s.exit_code = -1;
        }
    }
    scheduleLocked();
    unlockState();
    _ = std.c.close(fd);
}

fn onFrame(kind: u8, body: []const u8) void {
    switch (kind) {
        'S', 'D' => {
            const parts = ptyd.splitId(body) orelse return;
            lockState();
            defer unlockState();
            if (findLocked(parts.id)) |s| appendLocked(s, parts.rest);
        },
        'X' => {
            const parts = ptyd.splitId(body) orelse return;
            if (parts.rest.len != 4) return;
            lockState();
            defer unlockState();
            if (findLocked(parts.id)) |s| {
                s.exited = true;
                s.exit_code = std.mem.readInt(i32, parts.rest[0..4], .big);
                scheduleLocked();
            }
        },
        'E' => {
            var arena = std.heap.ArenaAllocator.init(cmd.gpa);
            defer arena.deinit();
            const E = struct { id: []const u8, message: []const u8 };
            const e = std.json.parseFromSliceLeaky(E, arena.allocator(), body, .{ .ignore_unknown_fields = true }) catch return;
            lockState();
            defer unlockState();
            if (findLocked(e.id)) |s| {
                const text = std.fmt.allocPrint(arena.allocator(), "\r\n\x1b[31mcould not start: {s}\x1b[0m\r\n", .{e.message}) catch return;
                appendLocked(s, text);
                s.exited = true;
                s.exit_code = 1;
            }
        },
        else => {},
    }
}

fn childEnv(a: std.mem.Allocator) ![]const []const u8 {
    var entries: std.ArrayList([]const u8) = .empty;
    const claude_session = std.c.getenv("CLAUDECODE") != null or std.c.getenv("CLAUDE_CODE_SESSION_ID") != null;
    var i: usize = 0;
    while (std.c.environ[i]) |entry| : (i += 1) {
        const text = std.mem.span(entry);
        if (claude_session and (std.mem.startsWith(u8, text, "CLAUDE") or std.mem.startsWith(u8, text, "MCP_") or
            std.mem.startsWith(u8, text, "ANTHROPIC_BASE_URL=")))
            continue;
        if (std.mem.startsWith(u8, text, "TERM=") or std.mem.startsWith(u8, text, "COLORTERM=") or std.mem.startsWith(u8, text, "FORCE_COLOR=")) continue;
        // the `vibe-open` helper comes first on PATH, so Claude's shell finds it
        if (std.mem.startsWith(u8, text, "PATH=")) {
            var dir_buf: [700]u8 = undefined;
            if (openreq.binDir(&dir_buf)) |dir| {
                try entries.append(a, try std.fmt.allocPrint(a, "PATH={s}:{s}", .{ dir, text["PATH=".len..] }));
                continue;
            }
        }
        try entries.append(a, text);
    }
    for ([_][]const u8{ "TERM=xterm-256color", "COLORTERM=truecolor", "FORCE_COLOR=1" }) |extra| {
        try entries.append(a, extra);
    }
    if (openreq.appExe().len > 0) try entries.append(a, try std.fmt.allocPrint(a, "TINJS_APP_BIN={s}", .{openreq.appExe()}));
    return entries.items;
}

/// The child's environment plus the chat's id, so `pty_cwds` can find the shell that belongs to the chat.
fn envWithMarker(a: std.mem.Allocator, id: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    try out.appendSlice(a, try childEnv(a));
    try out.append(a, try std.fmt.allocPrint(a, "{s}{s}", .{ marker, id }));
    return out.items;
}

const marker = "TINJS_PTY_ID=";

fn markerOf(environ: []const u8) ?[]const u8 {
    var parts = std.mem.splitScalar(u8, environ, 0);
    while (parts.next()) |part| {
        if (std.mem.startsWith(u8, part, marker)) return part[marker.len..];
    }
    return null;
}

const Found = struct { id: []const u8, pid: u32, cwd: []const u8 };

/// The folder each chat's shell is in now: `{id, cwd}` for every chat whose shell is running. The shell is the
/// lowest-numbered process carrying the chat's marker (its own children inherit the marker later).
pub fn cwds(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const Out = struct { id: []const u8, cwd: []const u8 };
    var found: std.ArrayList(Found) = .empty;

    var proc = std.Io.Dir.openDirAbsolute(cmd.io, "/proc", .{ .iterate = true }) catch return cmd.json(output, &[_]Out{});
    defer proc.close(cmd.io);
    var it = proc.iterate();
    while (it.next(cmd.io) catch null) |entry| {
        const pid = std.fmt.parseInt(u32, entry.name, 10) catch continue;
        const env_path = std.fmt.allocPrint(a, "/proc/{d}/environ", .{pid}) catch continue;
        const environ = std.Io.Dir.cwd().readFileAlloc(cmd.io, env_path, a, .limited(256 * 1024)) catch continue;
        const id = markerOf(environ) orelse continue;
        var known = false;
        for (found.items) |*f| {
            if (std.mem.eql(u8, f.id, id)) {
                known = true;
                if (pid < f.pid) f.pid = pid;
                break;
            }
        }
        if (!known) try found.append(a, .{ .id = id, .pid = pid, .cwd = "" });
    }

    var out: std.ArrayList(Out) = .empty;
    for (found.items) |f| {
        const link = std.fmt.allocPrint(a, "/proc/{d}/cwd", .{f.pid}) catch continue;
        var buf: [4096]u8 = undefined;
        const n = std.Io.Dir.readLinkAbsolute(cmd.io, link, &buf) catch continue;
        try out.append(a, .{ .id = f.id, .cwd = try a.dupe(u8, buf[0..n]) });
    }
    return cmd.json(output, out.items);
}

const SpawnOptions = struct {
    id: []const u8,
    cwd: []const u8,
    kind: []const u8,
    agent: ?[]const u8 = null,
    claudeArgs: ?[]const []const u8 = null,
    cols: u16 = 80,
    rows: u16 = 24,
    reuse: bool = false,
};

pub fn spawn(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { opts: SpawnOptions }, a, invocation);
    const opts = args.opts;

    lockState();
    if (findLocked(opts.id)) |existing| {
        if (opts.reuse and !existing.exited) {
            unlockState();
            return cmd.json(output, null);
        }
        destroyLocked(existing);
    }
    const record = newSessionLocked(opts.id) catch {
        unlockState();
        return cmd.fail(output, "the terminal could not be started");
    };
    unlockState();

    const shell_path = std.mem.span(std.c.getenv("SHELL") orelse "/bin/bash");
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(a, shell_path);
    if (std.mem.eql(u8, opts.kind, "claude")) {
        var line: std.ArrayList(u8) = .empty;
        try line.appendSlice(a, agentCommand(opts.agent));
        for (opts.claudeArgs orelse &.{}) |arg| {
            try line.append(a, ' ');
            try line.appendSlice(a, try quoteArg(a, arg));
        }
        try line.appendSlice(a, "; exec ");
        try line.appendSlice(a, shell_path);
        try argv.append(a, "-lc");
        try argv.append(a, line.items);
    } else {
        try argv.append(a, "-l");
    }

    const request = try std.json.Stringify.valueAlloc(a, .{
        .id = opts.id,
        .persist = !std.mem.eql(u8, opts.kind, "shell"),
        .reuse = opts.reuse,
        .cwd = opts.cwd,
        .argv = argv.items,
        .env = try envWithMarker(a, opts.id),
        .cols = opts.cols,
        .rows = opts.rows,
    }, .{});

    if (!sendFrame('N', request)) {
        lockState();
        destroyLocked(record);
        unlockState();
        return cmd.fail(output, "the terminal service could not be reached");
    }
    return cmd.json(output, null);
}

fn flush(_: ?*anyopaque) callconv(.c) c_int {
    var a = std.heap.ArenaAllocator.init(cmd.gpa);
    defer a.deinit();
    const arena = a.allocator();

    lockState();
    flush_scheduled = false;
    var index: usize = 0;
    while (index < sessions.items.len) {
        const s = sessions.items[index];
        const ready = completePrefix(s.outbox.items);
        if (ready > 0) {
            const text = cmd.lossy(arena, s.outbox.items[0..ready]) catch &.{};
            const json = std.json.Stringify.valueAlloc(arena, .{ s.id, text }, .{}) catch "[]";
            cmd.emit("pty:data", json);
            const rest = s.outbox.items[ready..];
            std.mem.copyForwards(u8, s.outbox.items[0..rest.len], rest);
            s.outbox.shrinkRetainingCapacity(rest.len);
        }
        if (s.exited and s.outbox.items.len == 0) {
            const json = std.json.Stringify.valueAlloc(arena, .{ s.id, s.exit_code }, .{}) catch "[]";
            cmd.emit("pty:exit", json);
            destroyLocked(s);
            continue;
        }
        index += 1;
    }
    unlockState();
    return 0;
}

fn completePrefix(bytes: []const u8) usize {
    var i = bytes.len;
    var back: usize = 0;
    while (i > 0 and back < 4) : (back += 1) {
        i -= 1;
        const c = bytes[i];
        if (c & 0xC0 == 0x80) continue;
        const need = std.unicode.utf8ByteSequenceLength(c) catch return bytes.len;
        return if (i + need <= bytes.len) bytes.len else i;
    }
    return bytes.len;
}

pub fn write(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, data: []const u8 }, a, invocation);

    lockState();
    const live = if (findLocked(args.id)) |s| !s.exited else false;
    unlockState();
    if (!live) return cmd.json(output, false);

    const body = try ptyd.forId(a, args.id, args.data);
    return cmd.json(output, sendToLive('I', body));
}

pub fn resize(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, cols: u16, rows: u16 }, a, invocation);
    const body = try std.json.Stringify.valueAlloc(a, .{ .id = args.id, .cols = args.cols, .rows = args.rows }, .{});
    _ = sendToLive('R', body);
    return cmd.json(output, null);
}

pub fn kill(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { id: []const u8 }, arena.allocator(), invocation);

    lockState();
    if (findLocked(args.id)) |s| destroyLocked(s);
    unlockState();
    _ = sendToLive('K', args.id);
    return cmd.json(output, null);
}

pub fn pageReset(_: cmd.Invocation, output: []u8) ![]const u8 {
    lockState();
    while (sessions.items.len > 0) destroyLocked(sessions.items[0]);
    unlockState();
    _ = sendToLive('W', "");
    return cmd.json(output, null);
}

pub fn list(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const empty: []const []const u8 = &.{};
    const path = ptyd.socketPath() orelse return cmd.json(output, empty);
    const fd = ptyd.connectSocket(path) orelse return cmd.json(output, empty);
    defer _ = std.c.close(fd);

    const hello = ptyd.readFrame(a, fd) catch return cmd.json(output, empty);
    if (hello.kind != 'H') return cmd.json(output, empty);
    const Ready = struct {
        version: u32,
        sessions: []const struct { id: []const u8, persist: bool, exited: bool, cols: u16, rows: u16 },
    };
    const ready = std.json.parseFromSliceLeaky(Ready, a, hello.body, .{ .ignore_unknown_fields = true }) catch return cmd.json(output, empty);
    var ids: std.ArrayList([]const u8) = .empty;
    for (ready.sessions) |s| {
        if (s.persist and !s.exited) try ids.append(a, s.id);
    }
    return cmd.json(output, ids.items);
}

pub fn visible(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, null);
}
