
const std = @import("std");
const cmd = @import("root.zig");

pub const version: u32 = 1;
const socket_name = "ptyd-native.sock";
const ring_size = 1 << 20;
const max_frame = 64 << 20;
const idle_limit_ms: u64 = 60_000;

pub const Winsize = extern struct { row: u16, col: u16, xpixel: u16 = 0, ypixel: u16 = 0 };
const tiocswinsz: c_ulong = 0x5414;

extern "c" fn forkpty(amaster: *c_int, name: ?[*]u8, termp: ?*const anyopaque, winp: ?*const Winsize) c_int;
extern "c" fn ioctl(fd: c_int, request: c_ulong, ...) c_int;
extern "c" fn usleep(usec: c_uint) c_int;


pub const Frame = struct { kind: u8, body: []u8 };

pub fn frame(a: std.mem.Allocator, kind: u8, body: []const u8) ![]u8 {
    const out = try a.alloc(u8, 5 + body.len);
    out[0] = kind;
    std.mem.writeInt(u32, out[1..5], @intCast(body.len), .big);
    @memcpy(out[5..], body);
    return out;
}

pub fn writeAll(fd: c_int, bytes: []const u8) bool {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = std.c.write(fd, bytes[offset..].ptr, bytes.len - offset);
        if (n <= 0) return false;
        offset += @intCast(n);
    }
    return true;
}

fn readAll(fd: c_int, buf: []u8) bool {
    var offset: usize = 0;
    while (offset < buf.len) {
        const n = std.c.read(fd, buf[offset..].ptr, buf.len - offset);
        if (n <= 0) return false;
        offset += @intCast(n);
    }
    return true;
}

pub fn readFrame(a: std.mem.Allocator, fd: c_int) !Frame {
    var head: [5]u8 = undefined;
    if (!readAll(fd, &head)) return error.Closed;
    const len = std.mem.readInt(u32, head[1..5], .big);
    if (len > max_frame) return error.FrameTooLarge;
    const body = try a.alloc(u8, len);
    errdefer a.free(body);
    if (!readAll(fd, body)) return error.Closed;
    return .{ .kind = head[0], .body = body };
}

pub fn forId(a: std.mem.Allocator, id: []const u8, data: []const u8) ![]u8 {
    const out = try a.alloc(u8, 1 + id.len + data.len);
    out[0] = @intCast(id.len);
    @memcpy(out[1 .. 1 + id.len], id);
    @memcpy(out[1 + id.len ..], data);
    return out;
}

pub fn splitId(payload: []const u8) ?struct { id: []const u8, rest: []const u8 } {
    if (payload.len == 0) return null;
    const n: usize = payload[0];
    if (payload.len < 1 + n) return null;
    return .{ .id = payload[1 .. 1 + n], .rest = payload[1 + n ..] };
}

pub fn socketPath() ?[:0]const u8 {
    const S = struct {
        var dir_buf: [512]u8 = undefined;
        var path_buf: [600]u8 = undefined;
    };
    const dir = cmd.userData(&S.dir_buf) catch return null;
    return std.fmt.bufPrintZ(&S.path_buf, "{s}/{s}", .{ dir, socket_name }) catch null;
}

pub fn unixAddress(path: []const u8) ?std.c.sockaddr.un {
    var addr = std.mem.zeroes(std.c.sockaddr.un);
    addr.family = std.c.AF.UNIX;
    if (path.len >= addr.path.len) return null;
    @memcpy(addr.path[0..path.len], path);
    return addr;
}

pub fn connectSocket(path: []const u8) ?c_int {
    const addr = unixAddress(path) orelse return null;
    const fd = std.c.socket(std.c.AF.UNIX, std.c.SOCK.STREAM, 0);
    if (fd < 0) return null;
    if (std.c.connect(fd, @ptrCast(&addr), @sizeOf(std.c.sockaddr.un)) != 0) {
        _ = std.c.close(fd);
        return null;
    }
    return fd;
}


const Session = struct {
    id: []u8,
    owner: u64,
    persist: bool,
    master: c_int,
    pid: c_int,
    cols: u16,
    rows: u16,
    ring: []u8,
    ring_pos: usize = 0,
    ring_full: bool = false,
    attached: ?u64 = null,
    exited: bool = false,
    exit_code: i32 = 0,
    dropped: bool = false,
    reader_done: bool = false,

    fn append(self: *Session, bytes: []const u8) void {
        const ring = self.ring;
        if (bytes.len >= ring.len) {
            @memcpy(ring, bytes[bytes.len - ring.len ..]);
            self.ring_pos = 0;
            self.ring_full = true;
            return;
        }
        const first = @min(bytes.len, ring.len - self.ring_pos);
        @memcpy(ring[self.ring_pos..][0..first], bytes[0..first]);
        const rest = bytes.len - first;
        if (rest > 0) @memcpy(ring[0..rest], bytes[first..]);
        if (self.ring_pos + bytes.len >= ring.len) self.ring_full = true;
        self.ring_pos = (self.ring_pos + bytes.len) % ring.len;
    }

    fn replay(self: *Session, a: std.mem.Allocator) ![]u8 {
        const reset = "\x1bc";
        const kept = if (self.ring_full) self.ring.len else self.ring_pos;
        const out = try a.alloc(u8, reset.len + kept);
        @memcpy(out[0..reset.len], reset);
        const body = out[reset.len..];
        if (!self.ring_full) {
            @memcpy(body, self.ring[0..self.ring_pos]);
        } else {
            @memcpy(body[0 .. self.ring.len - self.ring_pos], self.ring[self.ring_pos..]);
            @memcpy(body[self.ring.len - self.ring_pos ..], self.ring[0..self.ring_pos]);
        }
        return out;
    }
};

const Conn = struct { id: u64, fd: c_int };

var mutex: std.Io.Mutex = .init;
var sessions: std.ArrayList(*Session) = .empty;
var conns: std.ArrayList(Conn) = .empty;
var next_conn: u64 = 1;
var socket_file: [:0]const u8 = "";

fn lock() void {
    mutex.lockUncancelable(cmd.io);
}

fn unlock() void {
    mutex.unlock(cmd.io);
}

fn findLocked(id: []const u8) ?*Session {
    for (sessions.items) |s| {
        if (std.mem.eql(u8, s.id, id)) return s;
    }
    return null;
}

fn fdLocked(conn: u64) ?c_int {
    for (conns.items) |c| {
        if (c.id == conn) return c.fd;
    }
    return null;
}

fn sendLocked(conn: ?u64, kind: u8, body: []const u8) void {
    const fd = fdLocked(conn orelse return) orelse return;
    const bytes = frame(cmd.gpa, kind, body) catch return;
    defer cmd.gpa.free(bytes);
    _ = writeAll(fd, bytes);
}

fn sendIdLocked(conn: ?u64, kind: u8, id: []const u8, data: []const u8) void {
    const payload = forId(cmd.gpa, id, data) catch return;
    defer cmd.gpa.free(payload);
    sendLocked(conn, kind, payload);
}

fn exitCode(status: c_int) i32 {
    return if (status & 0x7f == 0) (status >> 8) & 0xff else -1;
}

fn dropLocked(s: *Session) bool {
    for (sessions.items, 0..) |item, i| {
        if (item == s) {
            _ = sessions.swapRemove(i);
            break;
        }
    }
    s.dropped = true;
    if (!s.exited) _ = std.c.kill(s.pid, .HUP);
    return s.reader_done;
}

fn freeSession(s: *Session) void {
    _ = std.c.close(s.master);
    cmd.gpa.free(s.id);
    cmd.gpa.free(s.ring);
    cmd.gpa.destroy(s);
}

fn resizeLocked(s: *Session, cols: u16, rows: u16) void {
    var ws = Winsize{ .row = @max(rows, 2), .col = @max(cols, 2) };
    _ = ioctl(s.master, tiocswinsz, &ws);
    s.cols = @max(cols, 2);
    s.rows = @max(rows, 2);
}

fn attachLocked(s: *Session, conn: u64, cols: u16, rows: u16) void {
    if (cols != s.cols or rows != s.rows) resizeLocked(s, cols, rows);
    s.attached = conn;
    const data = s.replay(cmd.gpa) catch return;
    defer cmd.gpa.free(data);
    sendIdLocked(conn, 'S', s.id, data);
    if (s.exited) {
        var code: [4]u8 = undefined;
        std.mem.writeInt(i32, &code, s.exit_code, .big);
        sendIdLocked(conn, 'X', s.id, &code);
    }
}

const NewRequest = struct {
    id: []const u8,
    persist: bool = false,
    reuse: bool = false,
    cwd: []const u8,
    argv: []const []const u8,
    env: []const []const u8,
    cols: u16 = 80,
    rows: u16 = 24,
};

fn spawnProcess(conn: u64, req: NewRequest) !*Session {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const argv = try a.allocSentinel(?[*:0]const u8, req.argv.len, null);
    for (req.argv, 0..) |arg, i| argv[i] = try a.dupeZ(u8, arg);
    const envp = try a.allocSentinel(?[*:0]const u8, req.env.len, null);
    for (req.env, 0..) |entry, i| envp[i] = try a.dupeZ(u8, entry);
    const cwd = try a.dupeZ(u8, req.cwd);
    if (argv.len == 0) return error.NoProgram;

    const cols = @max(req.cols, 2);
    const rows = @max(req.rows, 2);
    var ws = Winsize{ .row = rows, .col = cols };
    var master: c_int = -1;
    const pid = forkpty(&master, null, null, &ws);
    if (pid < 0) return error.TerminalNotStarted;
    if (pid == 0) {
        _ = std.c.chdir(cwd);
        _ = std.c.execve(argv[0].?, argv, envp);
        std.c._exit(127);
    }

    const s = try cmd.gpa.create(Session);
    errdefer cmd.gpa.destroy(s);
    const ring = try cmd.gpa.alloc(u8, ring_size);
    errdefer cmd.gpa.free(ring);
    s.* = .{
        .id = try cmd.gpa.dupe(u8, req.id),
        .owner = conn,
        .persist = req.persist,
        .master = master,
        .pid = pid,
        .cols = cols,
        .rows = rows,
        .ring = ring,
        .attached = conn,
    };
    return s;
}

fn sendErrorLocked(conn: u64, id: []const u8, message: []const u8) void {
    const body = std.json.Stringify.valueAlloc(cmd.gpa, .{ .id = id, .message = message }, .{}) catch return;
    defer cmd.gpa.free(body);
    sendLocked(conn, 'E', body);
}

fn handleNew(conn: u64, body: []const u8) void {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const req = std.json.parseFromSliceLeaky(NewRequest, a, body, .{ .ignore_unknown_fields = true }) catch return;

    lock();
    if (findLocked(req.id)) |existing| {
        if (req.reuse) {
            attachLocked(existing, conn, req.cols, req.rows);
            unlock();
            return;
        }
    }
    unlock();

    const s = spawnProcess(conn, req) catch |err| {
        lock();
        sendErrorLocked(conn, req.id, @errorName(err));
        unlock();
        return;
    };
    lock();
    var replaced: ?*Session = null;
    if (findLocked(req.id)) |old| {
        if (dropLocked(old)) replaced = old;
    }
    sessions.append(cmd.gpa, s) catch {};
    unlock();
    if (replaced) |old| freeSession(old);

    const thread = std.Thread.spawn(.{}, readLoop, .{s}) catch {
        lock();
        const free_now = dropLocked(s);
        unlock();
        if (free_now) freeSession(s);
        return;
    };
    thread.detach();
}

fn readLoop(s: *Session) void {
    var buf: [16 * 1024]u8 = undefined;
    while (true) {
        const n = std.c.read(s.master, &buf, buf.len);
        if (n <= 0) break;
        const chunk = buf[0..@intCast(n)];
        lock();
        if (s.dropped) {
            unlock();
            break;
        }
        s.append(chunk);
        if (s.attached) |conn| sendIdLocked(conn, 'D', s.id, chunk);
        unlock();
    }
    var status: c_int = 0;
    _ = std.c.waitpid(s.pid, &status, 0);

    lock();
    s.exited = true;
    s.exit_code = exitCode(status);
    if (!s.dropped) {
        var code: [4]u8 = undefined;
        std.mem.writeInt(i32, &code, s.exit_code, .big);
        sendIdLocked(s.attached, 'X', s.id, &code);
        if (!s.persist) _ = dropLocked(s);
    }
    s.reader_done = true;
    const free_now = s.dropped;
    unlock();
    if (free_now) freeSession(s);
}

fn handleInput(body: []const u8) void {
    const parts = splitId(body) orelse return;
    lock();
    const fd: ?c_int = if (findLocked(parts.id)) |s| (if (s.exited) null else s.master) else null;
    unlock();
    if (fd) |master| _ = writeAll(master, parts.rest);
}

fn handleResize(body: []const u8) void {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const R = struct { id: []const u8, cols: u16, rows: u16 };
    const r = std.json.parseFromSliceLeaky(R, arena.allocator(), body, .{ .ignore_unknown_fields = true }) catch return;
    lock();
    defer unlock();
    if (findLocked(r.id)) |s| resizeLocked(s, r.cols, r.rows);
}

fn handleKill(body: []const u8) void {
    lock();
    const free_now: ?*Session = if (findLocked(body)) |s| (if (dropLocked(s)) s else null) else null;
    unlock();
    if (free_now) |s| freeSession(s);
}

fn handleWipe() void {
    var doomed: std.ArrayList(*Session) = .empty;
    defer doomed.deinit(cmd.gpa);
    lock();
    for (sessions.items) |s| {
        if (!s.persist) doomed.append(cmd.gpa, s) catch {};
    }
    var to_free: std.ArrayList(*Session) = .empty;
    defer to_free.deinit(cmd.gpa);
    for (doomed.items) |s| {
        if (dropLocked(s)) to_free.append(cmd.gpa, s) catch {};
    }
    for (sessions.items) |s| s.attached = null;
    unlock();
    for (to_free.items) |s| freeSession(s);
}

fn readyJson(a: std.mem.Allocator) ![]u8 {
    const Info = struct { id: []const u8, persist: bool, exited: bool, cols: u16, rows: u16 };
    var list: std.ArrayList(Info) = .empty;
    for (sessions.items) |s| try list.append(a, .{ .id = s.id, .persist = s.persist, .exited = s.exited, .cols = s.cols, .rows = s.rows });
    return std.json.Stringify.valueAlloc(a, .{ .version = version, .sessions = list.items }, .{});
}

fn serveConn(fd: c_int, conn: u64) void {
    lock();
    conns.append(cmd.gpa, .{ .id = conn, .fd = fd }) catch {};
    {
        var arena = std.heap.ArenaAllocator.init(cmd.gpa);
        defer arena.deinit();
        if (readyJson(arena.allocator())) |ready| sendLocked(conn, 'H', ready) else |_| {}
    }
    unlock();

    while (readFrame(cmd.gpa, fd)) |f| {
        defer cmd.gpa.free(f.body);
        switch (f.kind) {
            'N' => handleNew(conn, f.body),
            'I' => handleInput(f.body),
            'R' => handleResize(f.body),
            'K' => handleKill(f.body),
            'W' => handleWipe(),
            else => {},
        }
    } else |_| {}

    var doomed: std.ArrayList(*Session) = .empty;
    defer doomed.deinit(cmd.gpa);
    lock();
    for (conns.items, 0..) |c, i| {
        if (c.id == conn) {
            _ = conns.swapRemove(i);
            break;
        }
    }
    for (sessions.items) |s| {
        if (s.owner == conn and !s.persist) doomed.append(cmd.gpa, s) catch {};
    }
    for (doomed.items) |s| {
        if (dropLocked(s)) freeSession(s);
    }
    for (sessions.items) |s| {
        if (s.attached == conn) s.attached = null;
    }
    unlock();
    _ = std.c.close(fd);
}

fn quitNow() noreturn {
    _ = std.c.unlink(socket_file.ptr);
    std.process.exit(0);
}

fn idleWatch() void {
    var idle_ms: u64 = 0;
    while (true) {
        _ = usleep(500_000);
        lock();
        const empty = sessions.items.len == 0 and conns.items.len == 0;
        unlock();
        idle_ms = if (empty) idle_ms + 500 else 0;
        if (idle_ms >= idle_limit_ms) quitNow();
    }
}

pub fn run() void {
    const path = socketPath() orelse return;
    if (connectSocket(path)) |fd| {
        _ = std.c.close(fd);
        return;
    }
    var dir_buf: [512]u8 = undefined;
    const dir = cmd.gpa.dupeZ(u8, cmd.userData(&dir_buf) catch return) catch return;
    defer cmd.gpa.free(dir);
    _ = std.c.mkdir(dir.ptr, 0o700);
    socket_file = cmd.gpa.dupeZ(u8, path) catch return;

    _ = std.c.unlink(socket_file.ptr);
    const listener = std.c.socket(std.c.AF.UNIX, std.c.SOCK.STREAM, 0);
    if (listener < 0) return;
    const addr = unixAddress(path) orelse return;
    if (std.c.bind(listener, @ptrCast(&addr), @sizeOf(std.c.sockaddr.un)) != 0) return;
    if (std.c.listen(listener, 16) != 0) return;

    const watcher = std.Thread.spawn(.{}, idleWatch, .{}) catch return;
    watcher.detach();

    while (true) {
        const fd = std.c.accept(listener, null, null);
        if (fd < 0) {
            _ = usleep(10_000);
            continue;
        }
        lock();
        const conn = next_conn;
        next_conn += 1;
        unlock();
        const thread = std.Thread.spawn(.{}, serveConn, .{ fd, conn }) catch {
            _ = std.c.close(fd);
            continue;
        };
        thread.detach();
    }
}
