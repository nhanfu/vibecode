//! Terminals: one pseudo-terminal per chat or shell, started in this process (forkpty). Output goes to
//! the page as `pty:data` events (id, text) and the end as `pty:exit` (id, code). Port of the spawn,
//! write, resize, kill and reset commands in src-tauri/src/pty.rs.
//!
//! Not yet ported: ptyd (src-tauri/src/ptyd.rs), the daemon that keeps a chat's terminal alive after
//! the app closes. Until then `pty_list` is empty and every terminal ends with the app (native/PLAN.md, step 3).
//! The chat's MCP settings (`mcp::settings_for`, `config_for`) are not passed to Claude Code yet.

const std = @import("std");
const cmd = @import("root.zig");

extern "c" fn forkpty(amaster: *c_int, name: ?[*]u8, termp: ?*const anyopaque, winp: ?*const Winsize) c_int;
extern "c" fn ioctl(fd: c_int, request: c_ulong, ...) c_int;

const Winsize = extern struct { row: u16, col: u16, xpixel: u16 = 0, ypixel: u16 = 0 };
const tiocswinsz: c_ulong = 0x5414;

/// (id, command on PATH): the coding agents the chat can run (src/shared/agents.ts).
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

/// Shell-safe argument (the POSIX form of src-tauri's quote_arg).
fn quoteArg(a: std.mem.Allocator, arg: []const u8) ![]const u8 {
    var plain = arg.len > 0;
    for (arg) |c| {
        if (!(std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_-./:=", c) != null)) plain = false;
    }
    if (plain) return arg;
    const out = try a.alloc(u8, arg.len + 2);
    var n: usize = 0;
    out[n] = '\'';
    n += 1;
    for (arg) |c| {
        if (c == '\'') {
            const piece = "'\\''";
            @memcpy(out[n .. n + piece.len], piece);
            n += piece.len;
        } else {
            out[n] = c;
            n += 1;
        }
    }
    out[n] = '\'';
    return out[0 .. n + 1];
}

const Session = struct {
    id: []u8,
    master: c_int,
    pid: c_int,
    outbox: std.ArrayList(u8) = .empty,
    exited: bool = false,
    exit_code: i32 = 0,
    killed: bool = false,
};

var mutex: std.Io.Mutex = .init;
var sessions: std.ArrayList(*Session) = .empty;
var flush_scheduled = false;

extern fn g_idle_add(function: *const fn (?*anyopaque) callconv(.c) c_int, data: ?*anyopaque) c_uint;

fn findLocked(id: []const u8) ?*Session {
    for (sessions.items) |s| {
        if (std.mem.eql(u8, s.id, id) and !s.killed) return s;
    }
    return null;
}

fn scheduleLocked() void {
    if (flush_scheduled) return;
    flush_scheduled = true;
    _ = g_idle_add(flush, null);
}

/// Environment for the child: the app's own, with the terminal type set. Claude Code's own variables
/// are dropped when this app was started from inside a Claude Code session (as the Tauri build does).
fn childEnv(a: std.mem.Allocator) ![:null]?[*:0]u8 {
    var entries: std.ArrayList(?[*:0]u8) = .empty;
    const claude_session = std.c.getenv("CLAUDECODE") != null or std.c.getenv("CLAUDE_CODE_SESSION_ID") != null;
    var i: usize = 0;
    while (std.c.environ[i]) |entry| : (i += 1) {
        const text = std.mem.span(entry);
        if (claude_session and (std.mem.startsWith(u8, text, "CLAUDE") or std.mem.startsWith(u8, text, "MCP_") or
            std.mem.startsWith(u8, text, "ANTHROPIC_BASE_URL=")))
            continue;
        if (std.mem.startsWith(u8, text, "TERM=") or std.mem.startsWith(u8, text, "COLORTERM=") or std.mem.startsWith(u8, text, "FORCE_COLOR=")) continue;
        try entries.append(a, try a.dupeZ(u8, text));
    }
    for ([_][]const u8{ "TERM=xterm-256color", "COLORTERM=truecolor", "FORCE_COLOR=1" }) |extra| {
        try entries.append(a, try a.dupeZ(u8, extra));
    }
    try entries.append(a, null);
    const items = entries.items;
    const envp = try a.allocSentinel(?[*:0]u8, items.len - 1, null);
    @memcpy(envp[0 .. items.len - 1], items[0 .. items.len - 1]);
    return envp;
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

/// `{ opts }`: starts the terminal. A chat runs its coding agent inside a login shell, so the user
/// lands in the shell in the same folder when the agent exits; a shell runs a login shell.
pub fn spawn(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { opts: SpawnOptions }, a, invocation);
    const opts = args.opts;

    mutex.lockUncancelable(cmd.io);
    const existing = findLocked(opts.id) != null;
    mutex.unlock(cmd.io);
    if (existing) return cmd.json(output, null);

    const shell_path = std.mem.span(std.c.getenv("SHELL") orelse "/bin/bash");
    var argv: std.ArrayList(?[*:0]const u8) = .empty;
    try argv.append(a, try a.dupeZ(u8, shell_path));
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
        try argv.append(a, try a.dupeZ(u8, line.items));
    } else {
        try argv.append(a, "-l");
    }
    try argv.append(a, null);
    const argv_z = try a.allocSentinel(?[*:0]const u8, argv.items.len - 1, null);
    @memcpy(argv_z[0 .. argv.items.len - 1], argv.items[0 .. argv.items.len - 1]);

    const envp = try childEnv(a);
    const cwd_z = try a.dupeZ(u8, opts.cwd);
    var ws = Winsize{ .row = @max(opts.rows, 2), .col = @max(opts.cols, 2) };
    var master: c_int = -1;
    const pid = forkpty(&master, null, null, &ws);
    if (pid < 0) return cmd.fail(output, "the terminal could not be started");
    if (pid == 0) {
        _ = std.c.chdir(cwd_z);
        _ = std.c.execve(argv_z[0].?, argv_z, envp);
        std.c._exit(127);
    }

    const session = try cmd.gpa.create(Session);
    session.* = .{ .id = try cmd.gpa.dupe(u8, opts.id), .master = master, .pid = pid };
    mutex.lockUncancelable(cmd.io);
    try sessions.append(cmd.gpa, session);
    mutex.unlock(cmd.io);

    const thread = try std.Thread.spawn(.{}, readLoop, .{session});
    thread.detach();
    return cmd.json(output, null);
}

/// Reads the terminal until it ends, queues the output for the page, and records the exit code.
fn readLoop(session: *Session) void {
    var buffer: [8192]u8 = undefined;
    while (true) {
        const n = std.c.read(session.master, &buffer, buffer.len);
        if (n <= 0) break;
        mutex.lockUncancelable(cmd.io);
        session.outbox.appendSlice(cmd.gpa, buffer[0..@intCast(n)]) catch {};
        scheduleLocked();
        mutex.unlock(cmd.io);
    }
    var status: c_int = 0;
    _ = std.c.waitpid(session.pid, &status, 0);
    const code: i32 = if (status & 0x7f == 0) (status >> 8) & 0xff else -1;
    mutex.lockUncancelable(cmd.io);
    session.exit_code = code;
    session.exited = true;
    scheduleLocked();
    mutex.unlock(cmd.io);
}

/// Length of the prefix of `bytes` that ends on a whole UTF-8 character; the rest waits for more bytes.
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

/// GTK thread: sends the queued output and exits of every terminal, then frees the ended ones.
fn flush(_: ?*anyopaque) callconv(.c) c_int {
    var a = std.heap.ArenaAllocator.init(cmd.gpa);
    defer a.deinit();
    const arena = a.allocator();

    mutex.lockUncancelable(cmd.io);
    flush_scheduled = false;
    var index: usize = 0;
    while (index < sessions.items.len) {
        const s = sessions.items[index];
        const ready = completePrefix(s.outbox.items);
        if (s.killed) {
            if (s.exited) {
                _ = std.c.close(s.master);
                cmd.gpa.free(s.id);
                s.outbox.deinit(cmd.gpa);
                _ = sessions.swapRemove(index);
                cmd.gpa.destroy(s);
                continue;
            }
            index += 1;
            continue;
        }
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
            _ = std.c.close(s.master);
            cmd.gpa.free(s.id);
            s.outbox.deinit(cmd.gpa);
            _ = sessions.swapRemove(index);
            cmd.gpa.destroy(s);
            continue;
        }
        index += 1;
    }
    mutex.unlock(cmd.io);
    return 0;
}

/// `{ id, data }`: types into the terminal. False when there is no live terminal with that id.
pub fn write(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, data: []const u8 }, a, invocation);

    mutex.lockUncancelable(cmd.io);
    const session = findLocked(args.id);
    const master: c_int = if (session) |s| (if (s.exited) -1 else s.master) else -1;
    mutex.unlock(cmd.io);
    if (master < 0) return cmd.json(output, false);

    var offset: usize = 0;
    while (offset < args.data.len) {
        const n = std.c.write(master, args.data[offset..].ptr, args.data.len - offset);
        if (n <= 0) return cmd.json(output, false);
        offset += @intCast(n);
    }
    return cmd.json(output, true);
}

/// `{ id, cols, rows }`: tells the terminal its new size.
pub fn resize(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, cols: u16, rows: u16 }, a, invocation);

    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    if (findLocked(args.id)) |s| {
        var ws = Winsize{ .row = @max(args.rows, 2), .col = @max(args.cols, 2) };
        _ = ioctl(s.master, tiocswinsz, &ws);
    }
    return cmd.json(output, null);
}

/// `{ id }`: stops the terminal. Its exit is not reported to the page.
pub fn kill(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8 }, a, invocation);

    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    if (findLocked(args.id)) |s| {
        s.killed = true;
        _ = std.c.kill(s.pid, .HUP);
    }
    return cmd.json(output, null);
}

/// The page starts: every terminal left from a previous page is stopped (there is no ptyd yet to keep them).
pub fn pageReset(_: cmd.Invocation, output: []u8) ![]const u8 {
    mutex.lockUncancelable(cmd.io);
    defer mutex.unlock(cmd.io);
    for (sessions.items) |s| {
        if (!s.killed) {
            s.killed = true;
            _ = std.c.kill(s.pid, .HUP);
        }
    }
    return cmd.json(output, null);
}

/// The chats' terminals still running from before the app closed: none until ptyd is ported.
pub fn list(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, @as([]const []const u8, &.{}));
}

/// `{ id, visible }`: accepted; the output rate is not throttled yet.
pub fn visible(_: cmd.Invocation, output: []u8) ![]const u8 {
    return cmd.json(output, null);
}
