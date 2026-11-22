//! Plugins: folders with a `plugin.json`, found in `<userData>/plugins/` (installed by the user, wins over
//! a shipped copy of the same id), in the app's bundled `plugins/` folder and, while developing, in
//! `$VIBE_PLUGINS_DIR`. Port of src-tauri/src/plugins.rs (see docs/plugins.md there).
//!
//! A plugin can bring a sidecar: a program started on a free localhost port with a random token, waited
//! for (its health path), and shown as a web page in a panel. Sidecars run in their own process group,
//! die with the app (PR_SET_PDEATHSIG), and their output is kept for `plugin_logs`.
//!
//! Differences from the Tauri build, for now: downloads and the registry use `curl` (it must be on PATH);
//! archives are unpacked with `unzip` / `tar`; sidecars are not started at app launch (only when a panel
//! opens them); the MCP servers plugins bring are not handed to chats yet.

const std = @import("std");
const linux = std.os.linux;
const cmd = @import("root.zig");

const Allocator = std.mem.Allocator;

extern "c" fn fork() c_int;
extern "c" fn socket(domain: c_int, sock_type: c_int, protocol: c_int) c_int;
extern "c" fn close(fd: c_int) c_int;

/// The app's version, for `minAppVersion` checks (src-tauri/Cargo.toml).
const app_version = "0.2.0";
const max_download_bytes: u64 = 600 * 1024 * 1024;
const log_lines_kept: usize = 1000;
const default_registry = "https://raw.githubusercontent.com/nhanfu/vibecode/master/plugins/index.json";

const PanelSpec = struct {
    title: []const u8,
    icon: []const u8 = "",
    replaces: ?[]const u8 = null,
    folder: bool = false,
};

const ThemeSpec = struct {
    file: []const u8,
    key: []const u8,
    dark: []const u8,
    light: []const u8,
};

const Sidecar = struct {
    theme: ?ThemeSpec = null,
    settings: ?[]const u8 = null,
    command: []const u8,
    args: []const []const u8 = &.{},
    env: std.json.Value = .{ .object = std.json.ObjectMap.empty },
    health: ?[]const u8 = null,
    url: []const u8 = "/",
    autostart: bool = false,
};

const McpSpec = struct {
    name: []const u8,
    path: []const u8,
    bearer: bool = false,
};

const Manifest = struct {
    id: []const u8,
    name: []const u8,
    version: []const u8 = "",
    description: []const u8 = "",
    license: []const u8 = "",
    homepage: []const u8 = "",
    panel: ?PanelSpec = null,
    sidecar: ?Sidecar = null,
    mcp: ?McpSpec = null,
    minAppVersion: []const u8 = "",
    platforms: []const []const u8 = &.{},
};

const Source = enum { bundled, user, dev };

const Plugin = struct {
    manifest: Manifest,
    dir: []const u8,
    source: Source,
    overrides: bool = false,
};

/// `1.2.10` > `1.2.9`: numeric parts, missing ones count as 0.
fn newer(a: []const u8, b: []const u8) bool {
    var pa = std.mem.splitAny(u8, std.mem.trimStart(u8, a, "v"), ".-+");
    var pb = std.mem.splitAny(u8, std.mem.trimStart(u8, b, "v"), ".-+");
    while (true) {
        const x = if (pa.next()) |s| std.fmt.parseInt(u64, s, 10) catch 0 else null;
        const y = if (pb.next()) |s| std.fmt.parseInt(u64, s, 10) catch 0 else null;
        if (x == null and y == null) return false;
        const xv = x orelse 0;
        const yv = y orelse 0;
        if (xv != yv) return xv > yv;
    }
}

fn onThisSystem(platforms: []const []const u8) bool {
    if (platforms.len == 0) return true;
    for (platforms) |p| {
        if (std.ascii.eqlIgnoreCase(p, "linux")) return true;
    }
    return false;
}

fn fileExists(path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(cmd.io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn dirExists(path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(cmd.io, path, .{}) catch return false;
    return stat.kind == .directory;
}

/// Why it cannot run here (null: ready).
fn problem(a: Allocator, p: Plugin) !?[]const u8 {
    const m = p.manifest;
    if (!onThisSystem(m.platforms)) return try std.fmt.allocPrint(a, "no build for linux", .{});
    if (m.minAppVersion.len > 0 and newer(m.minAppVersion, app_version)) {
        return try std.fmt.allocPrint(a, "needs app {s} or newer (this is {s})", .{ m.minAppVersion, app_version });
    }
    if (m.sidecar) |side| {
        if (try programPath(a, p.dir, side.command) == null) return "its program is missing (not built or installed)";
    }
    return null;
}

fn programPath(a: Allocator, dir: []const u8, command: []const u8) !?[]const u8 {
    const path = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir, command });
    return if (fileExists(path)) path else null;
}

fn available(a: Allocator, p: Plugin) bool {
    return (problem(a, p) catch return false) == null;
}

fn userDataDir(a: Allocator) ![]const u8 {
    var buffer: [4096]u8 = undefined;
    return a.dupe(u8, try cmd.userData(&buffer));
}

fn userPlugins(a: Allocator) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}/plugins", .{try userDataDir(a)});
}

const Root = struct { path: []const u8, source: Source };

/// The folders searched, in order: the user's own, then the bundled ones next to the checkout.
fn roots(a: Allocator) ![]const Root {
    var found: std.ArrayList(Root) = .empty;
    if (std.c.getenv("VIBE_PLUGINS_DIR")) |raw| try found.append(a, .{ .path = std.mem.span(raw), .source = .dev });
    try found.append(a, .{ .path = try userPlugins(a), .source = .user });
    const cwd = try std.process.currentPathAlloc(cmd.io, a);
    try found.append(a, .{ .path = try std.fmt.allocPrint(a, "{s}/plugins", .{cwd}), .source = .bundled });
    try found.append(a, .{ .path = try std.fmt.allocPrint(a, "{s}/../plugins", .{cwd}), .source = .bundled });
    return found.items;
}

/// Every plugin found, the first folder of an id winning.
fn discover(a: Allocator) ![]Plugin {
    var out: std.ArrayList(Plugin) = .empty;
    for (try roots(a)) |root| {
        var dir = std.Io.Dir.cwd().openDir(cmd.io, root.path, .{ .iterate = true }) catch continue;
        defer dir.close(cmd.io);
        var names: std.ArrayList([]const u8) = .empty;
        var it = dir.iterate();
        while (try it.next(cmd.io)) |entry| {
            if (entry.kind != .directory or std.mem.startsWith(u8, entry.name, ".")) continue;
            try names.append(a, try a.dupe(u8, entry.name));
        }
        std.mem.sort([]const u8, names.items, {}, lessString);
        for (names.items) |name| {
            const folder = try std.fmt.allocPrint(a, "{s}/{s}", .{ root.path, name });
            const raw = std.Io.Dir.cwd().readFileAlloc(cmd.io, try std.fmt.allocPrint(a, "{s}/plugin.json", .{folder}), a, .limited(1024 * 1024)) catch continue;
            const manifest = std.json.parseFromSliceLeaky(Manifest, a, raw, .{ .ignore_unknown_fields = true }) catch continue;
            var duplicate: ?*Plugin = null;
            for (out.items) |*p| {
                if (std.mem.eql(u8, p.manifest.id, manifest.id)) duplicate = p;
            }
            if (duplicate) |first| {
                if (!std.mem.eql(u8, first.dir, folder)) first.overrides = true;
            } else {
                try out.append(a, .{ .manifest = manifest, .dir = folder, .source = root.source });
            }
        }
    }
    var kept: std.ArrayList(Plugin) = .empty;
    for (out.items) |p| {
        if (!isRemoved(p.manifest.id)) try kept.append(a, p);
    }
    return kept.items;
}

fn lessString(_: void, l: []const u8, r: []const u8) bool {
    return std.mem.lessThan(u8, l, r);
}

fn find(a: Allocator, id: []const u8) !?Plugin {
    for (try discover(a)) |p| {
        if (std.mem.eql(u8, p.manifest.id, id)) return p;
    }
    return null;
}

// ---------------- settings (enabled / autostart / registry) ----------------

const Prefs = struct {
    root: std.json.Value,
    arena: std.heap.ArenaAllocator,
};

var prefs_state: ?Prefs = null;

fn prefsPath(a: Allocator) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}/plugin-settings.json", .{try userDataDir(a)});
}

/// The settings file as a JSON object (created in memory when there is none yet).
fn loadPrefs() *Prefs {
    if (prefs_state) |*p| return p;
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    const a = arena.allocator();
    var root: std.json.Value = .{ .object = std.json.ObjectMap.empty };
    if (prefsPath(a)) |path| {
        if (std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(1024 * 1024))) |raw| {
            if (std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{})) |v| root = v else |_| {}
        } else |_| {}
    } else |_| {}
    prefs_state = .{ .root = root, .arena = arena };
    return &prefs_state.?;
}

fn prefsObject(p: *Prefs) *std.json.ObjectMap {
    return &p.root.object;
}

fn pluginPrefs(p: *Prefs, id: []const u8) ?std.json.Value {
    const plugins = prefsObject(p).get("plugins") orelse return null;
    if (plugins != .object) return null;
    return plugins.object.get(id);
}

fn isRemoved(id: []const u8) bool {
    const p = loadPrefs();
    const entry = pluginPrefs(p, id) orelse return false;
    if (entry != .object) return false;
    const removed = entry.object.get("removed") orelse return false;
    return removed == .bool and removed.bool;
}

fn isEnabled(id: []const u8) bool {
    const p = loadPrefs();
    const entry = pluginPrefs(p, id) orelse return true;
    if (entry != .object) return true;
    const disabled = entry.object.get("disabled") orelse return true;
    return !(disabled == .bool and disabled.bool);
}

fn autostarts(p: Plugin) bool {
    const manifest_default = if (p.manifest.sidecar) |s| s.autostart else false;
    const entry = pluginPrefs(loadPrefs(), p.manifest.id) orelse return manifest_default;
    if (entry != .object) return manifest_default;
    const value = entry.object.get("autostart") orelse return manifest_default;
    return switch (value) {
        .bool => |b| b,
        else => manifest_default,
    };
}

/// The settings entry of one plugin, created when missing. Keys are copied into the settings' own arena:
/// the map keeps them, and the caller's arena is freed when its request ends.
fn pluginEntry(p: *Prefs, id: []const u8) !*std.json.ObjectMap {
    const a = p.arena.allocator();
    if (prefsObject(p).getPtr("plugins") == null) try prefsObject(p).put(a, "plugins", .{ .object = std.json.ObjectMap.empty });
    const plugins = prefsObject(p).getPtr("plugins").?;
    if (plugins.object.getPtr(id) == null) try plugins.object.put(a, try a.dupe(u8, id), .{ .object = std.json.ObjectMap.empty });
    return &plugins.object.getPtr(id).?.object;
}

// ---------------- running sidecars ----------------

const Running = struct {
    id: []const u8,
    port: u16,
    token: []const u8,
    pid: c_int,
    exited: ?u32 = null,
};

var state_mutex: std.Io.Mutex = .init;
var running: std.ArrayList(Running) = .empty;
var errors: std.StringHashMap([]const u8) = undefined;
var errors_ready = false;
var logs: std.StringHashMap(std.ArrayList([]const u8)) = undefined;
var logs_ready = false;
var starting: std.StringHashMap(void) = undefined;
var starting_ready = false;

fn ensureState() void {
    if (!errors_ready) {
        errors = std.StringHashMap([]const u8).init(cmd.gpa);
        logs = std.StringHashMap(std.ArrayList([]const u8)).init(cmd.gpa);
        starting = std.StringHashMap(void).init(cmd.gpa);
        errors_ready = true;
        logs_ready = true;
        starting_ready = true;
    }
}

fn logLine(id: []const u8, line: []const u8) void {
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    ensureState();
    const gop = logs.getOrPut(id) catch return;
    if (!gop.found_existing) {
        gop.key_ptr.* = cmd.gpa.dupe(u8, id) catch return;
        gop.value_ptr.* = .empty;
    }
    const kept = line[0..@min(line.len, 2000)];
    const copy = cmd.gpa.dupe(u8, kept) catch return;
    if (gop.value_ptr.items.len >= log_lines_kept) cmd.gpa.free(gop.value_ptr.orderedRemove(0));
    gop.value_ptr.append(cmd.gpa, copy) catch cmd.gpa.free(copy);
}

/// Copies a sidecar's output (one of its pipes) into its log until the pipe closes.
fn pump(id: []const u8, fd: c_int) void {
    var pending: std.ArrayList(u8) = .empty;
    defer pending.deinit(cmd.gpa);
    var buffer: [4096]u8 = undefined;
    while (true) {
        const n = std.c.read(fd, &buffer, buffer.len);
        if (n <= 0) break;
        pending.appendSlice(cmd.gpa, buffer[0..@intCast(n)]) catch break;
        while (std.mem.indexOfScalar(u8, pending.items, '\n')) |nl| {
            logLine(id, pending.items[0..nl]);
            const rest = pending.items[nl + 1 ..];
            std.mem.copyForwards(u8, pending.items[0..rest.len], rest);
            pending.shrinkRetainingCapacity(rest.len);
        }
    }
    if (pending.items.len > 0) logLine(id, pending.items);
    _ = close(fd);
}

fn stateKnown(id: []const u8) ?Running {
    for (running.items) |r| {
        if (std.mem.eql(u8, r.id, id)) return r;
    }
    return null;
}

fn removeRunning(id: []const u8) ?Running {
    for (running.items, 0..) |r, i| {
        if (std.mem.eql(u8, r.id, id)) return running.swapRemove(i);
    }
    return null;
}

fn killGroup(pid: c_int) void {
    _ = std.c.kill(-pid, .KILL);
    _ = std.c.kill(pid, .KILL);
}

/// Reaps a sidecar that already exited; returns its status when it did.
fn reapExited(id: []const u8) ?u32 {
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    for (running.items) |*r| {
        if (!std.mem.eql(u8, r.id, id)) continue;
        if (r.exited) |code| return code;
        var status: c_int = 0;
        const rc = std.c.waitpid(r.pid, &status, std.c.W.NOHANG);
        if (rc == r.pid) {
            r.exited = @intCast(status);
            return r.exited;
        }
    }
    return null;
}

fn stopSidecar(id: []const u8) bool {
    state_mutex.lockUncancelable(cmd.io);
    const removed = removeRunning(id);
    state_mutex.unlock(cmd.io);
    const r = removed orelse return false;
    killGroup(r.pid);
    var status: c_int = 0;
    _ = std.c.waitpid(r.pid, &status, 0);
    logLine(id, "[stopped]");
    return true;
}

/// Free localhost port (bound once, then released).
fn freePort() !u16 {
    const fd = socket(2, 1, 0);
    if (fd < 0) return error.SocketFailed;
    defer _ = close(fd);
    var addr = std.posix.sockaddr.in{ .port = 0, .addr = std.mem.nativeToBig(u32, 0x7f000001) };
    if (std.c.bind(fd, @ptrCast(&addr), @sizeOf(std.posix.sockaddr.in)) != 0) return error.BindFailed;
    var len: std.posix.socklen_t = @sizeOf(std.posix.sockaddr.in);
    if (std.c.getsockname(fd, @ptrCast(&addr), &len) != 0) return error.BindFailed;
    return std.mem.bigToNative(u16, addr.port);
}

fn portFree(port: u16) bool {
    const fd = socket(2, 1, 0);
    if (fd < 0) return false;
    defer _ = close(fd);
    var addr = std.posix.sockaddr.in{ .port = std.mem.nativeToBig(u16, port), .addr = std.mem.nativeToBig(u32, 0x7f000001) };
    return std.c.bind(fd, @ptrCast(&addr), @sizeOf(std.posix.sockaddr.in)) == 0;
}

fn randomToken(a: Allocator) ![]const u8 {
    var bytes: [24]u8 = undefined;
    _ = linux.getrandom(&bytes, bytes.len, 0);
    const out = try a.alloc(u8, bytes.len * 2);
    for (bytes, 0..) |b, i| _ = std.fmt.bufPrint(out[i * 2 .. i * 2 + 2], "{x:0>2}", .{b}) catch unreachable;
    return out;
}

/// The port and token of the plugin's last start, kept in its data folder, while that port is still free.
fn endpoint(a: Allocator, data: []const u8) !struct { port: u16, token: []const u8 } {
    const file = try std.fmt.allocPrint(a, "{s}/endpoint.json", .{data});
    if (std.Io.Dir.cwd().readFileAlloc(cmd.io, file, a, .limited(4096))) |raw| {
        if (std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{})) |v| {
            if (v == .object) {
                const port_value = v.object.get("port");
                const token_value = v.object.get("token");
                if (port_value != null and token_value != null and port_value.? == .integer and token_value.? == .string) {
                    const port: u16 = @intCast(port_value.?.integer);
                    if (portFree(port)) return .{ .port = port, .token = token_value.?.string };
                }
            }
        } else |_| {}
    } else |_| {}
    const port = try freePort();
    const token = try randomToken(a);
    const text = try std.fmt.allocPrint(a, "{{\"port\":{d},\"token\":\"{s}\"}}", .{ port, token });
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = text });
    return .{ .port = port, .token = token };
}

/// `curl` answers 2xx at `path` on the sidecar's port.
fn healthy(a: Allocator, port: u16, path: []const u8) bool {
    const url = std.fmt.allocPrint(a, "http://127.0.0.1:{d}{s}", .{ port, path }) catch return false;
    const result = std.process.run(a, cmd.io, .{
        .argv = &.{ "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", url },
        .stdout_limit = .limited(16),
    }) catch return false;
    const code = std.fmt.parseInt(u16, std.mem.trim(u8, result.stdout, " \r\n\t"), 10) catch return false;
    return code >= 200 and code < 300;
}

fn fill(a: Allocator, text: []const u8, port: u16, token: []const u8, dir: []const u8, data: []const u8) ![]const u8 {
    const port_text = try std.fmt.allocPrint(a, "{d}", .{port});
    var out = try std.mem.replaceOwned(u8, a, text, "{port}", port_text);
    out = try std.mem.replaceOwned(u8, a, out, "{token}", token);
    out = try std.mem.replaceOwned(u8, a, out, "{dir}", dir);
    return std.mem.replaceOwned(u8, a, out, "{data}", data);
}

fn cString(a: Allocator, text: []const u8) ![:0]const u8 {
    return a.dupeZ(u8, text);
}

/// Starts the sidecar's program in its own process group, with its output on two pipes.
/// The child dies with the app (PR_SET_PDEATHSIG) and cannot outlive a crash of this process.
fn spawnSidecar(a: Allocator, p: Plugin, program: []const u8, port: u16, token: []const u8, data: []const u8) !c_int {
    const side = p.manifest.sidecar.?;
    var argv: std.ArrayList(?[*:0]const u8) = .empty;
    try argv.append(a, (try cString(a, program)).ptr);
    for (side.args) |arg| try argv.append(a, (try cString(a, try fill(a, arg, port, token, p.dir, data))).ptr);
    try argv.append(a, null);
    const argv_z: [*:null]const ?[*:0]const u8 = @ptrCast((try argv.toOwnedSlice(a)).ptr);

    var envp: std.ArrayList(?[*:0]const u8) = .empty;
    const env = std.c.environ;
    var i: usize = 0;
    while (env[i]) |entry| : (i += 1) {
        const text = std.mem.span(entry);
        var skip = false;
        if (side.env == .object) {
            for (side.env.object.keys()) |k| {
                if (std.mem.startsWith(u8, text, k) and text.len > k.len and text[k.len] == '=') skip = true;
            }
        }
        if (!skip) try envp.append(a, (try a.dupeZ(u8, text)).ptr);
    }
    if (side.env == .object) {
        for (side.env.object.keys(), side.env.object.values()) |k, v| {
            if (v != .string) continue;
            const value = try fill(a, v.string, port, token, p.dir, data);
            try envp.append(a, (try cString(a, try std.fmt.allocPrint(a, "{s}={s}", .{ k, value }))).ptr);
        }
    }
    try envp.append(a, null);
    const envp_z: [*:null]const ?[*:0]const u8 = @ptrCast((try envp.toOwnedSlice(a)).ptr);

    var out_pipe: [2]c_int = undefined;
    var err_pipe: [2]c_int = undefined;
    if (std.c.pipe(&out_pipe) != 0 or std.c.pipe(&err_pipe) != 0) return error.PipeFailed;
    const dir_z = try cString(a, p.dir);
    const program_z = try cString(a, program);
    const pid = fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = std.c.setpgid(0, 0);
        _ = linux.prctl(1, 9, 0, 0, 0); // PR_SET_PDEATHSIG, SIGKILL
        _ = std.c.dup2(out_pipe[1], 1);
        _ = std.c.dup2(err_pipe[1], 2);
        _ = std.c.chdir(dir_z.ptr);
        _ = std.c.execve(program_z.ptr, @ptrCast(argv_z), @ptrCast(envp_z));
        std.c._exit(127);
    }
    _ = close(out_pipe[1]);
    _ = close(err_pipe[1]);
    const id = try a.dupe(u8, p.manifest.id);
    const out_thread = try std.Thread.spawn(.{}, pump, .{ id, out_pipe[0] });
    out_thread.detach();
    const err_thread = try std.Thread.spawn(.{}, pump, .{ id, err_pipe[0] });
    err_thread.detach();
    return pid;
}

fn setError(id: []const u8, message: []const u8) void {
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    ensureState();
    const copy = cmd.gpa.dupe(u8, message) catch return;
    const gop = errors.getOrPut(id) catch return;
    if (gop.found_existing) cmd.gpa.free(gop.value_ptr.*) else gop.key_ptr.* = cmd.gpa.dupe(u8, id) catch return;
    gop.value_ptr.* = copy;
}

fn clearError(id: []const u8) void {
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    ensureState();
    if (errors.fetchRemove(id)) |kv| cmd.gpa.free(kv.value);
}

/// Starts a plugin's sidecar, or finds it already up. Returns its port and token.
fn ensure(a: Allocator, p: Plugin) !struct { port: u16, token: []const u8 } {
    if (try problem(a, p)) |_| return error.PluginUnavailable;
    const side = p.manifest.sidecar orelse return error.NoSidecar;
    const health = side.health orelse "/";

    state_mutex.lockUncancelable(cmd.io);
    const known = stateKnown(p.manifest.id);
    state_mutex.unlock(cmd.io);
    if (known) |k| {
        if (healthy(a, k.port, health)) return .{ .port = k.port, .token = k.token };
        state_mutex.lockUncancelable(cmd.io);
        const stale = removeRunning(p.manifest.id);
        state_mutex.unlock(cmd.io);
        if (stale) |s| killGroup(s.pid);
    }

    const program = (try programPath(a, p.dir, side.command)) orelse return error.NotBuilt;
    const data = try std.fmt.allocPrint(a, "{s}/plugin-data/{s}", .{ try userDataDir(a), p.manifest.id });
    try std.Io.Dir.cwd().createDirPath(cmd.io, data);
    const ep = try endpoint(a, data);
    logLine(p.manifest.id, try std.fmt.allocPrint(a, "[start] {s} on port {d}", .{ program, ep.port }));
    const pid = try spawnSidecar(a, p, program, ep.port, ep.token, data);

    state_mutex.lockUncancelable(cmd.io);
    try running.append(cmd.gpa, .{ .id = try cmd.gpa.dupe(u8, p.manifest.id), .port = ep.port, .token = try cmd.gpa.dupe(u8, ep.token), .pid = pid });
    state_mutex.unlock(cmd.io);

    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        if (healthy(a, ep.port, health)) {
            logLine(p.manifest.id, "[ready]");
            return .{ .port = ep.port, .token = ep.token };
        }
        if (reapExited(p.manifest.id)) |_| {
            state_mutex.lockUncancelable(cmd.io);
            _ = removeRunning(p.manifest.id);
            state_mutex.unlock(cmd.io);
            return error.ExitedAtStart;
        }
        std.Io.sleep(cmd.io, std.Io.Duration.fromMilliseconds(150), .real) catch {};
    }
    _ = stopSidecar(p.manifest.id);
    return error.DidNotAnswer;
}

// ---------------- commands ----------------

const PluginInfo = struct {
    id: []const u8,
    name: []const u8,
    version: []const u8,
    description: []const u8,
    license: []const u8,
    homepage: []const u8,
    panel: ?PanelSpec,
    available: bool,
    mcp: bool,
    mcpName: ?[]const u8,
    source: Source,
    overrides: bool,
    enabled: bool,
    hasSidecar: bool,
    hasSettings: bool,
    autostart: bool,
    status: []const u8,
    @"error": ?[]const u8,
    port: ?u16,
    platforms: []const []const u8,
};

fn info(a: Allocator, p: Plugin) !PluginInfo {
    const id = p.manifest.id;
    const issue = try problem(a, p);
    const is_enabled = isEnabled(id);
    if (reapExited(id)) |code| {
        state_mutex.lockUncancelable(cmd.io);
        _ = removeRunning(id);
        state_mutex.unlock(cmd.io);
        const text = try std.fmt.allocPrint(a, "exited ({d})", .{code});
        setError(id, text);
        logLine(id, text);
    }
    state_mutex.lockUncancelable(cmd.io);
    ensureState();
    const run = stateKnown(id);
    const was_starting = starting.contains(id);
    const last_error = errors.get(id);
    state_mutex.unlock(cmd.io);

    var status: []const u8 = "ready";
    var error_text: ?[]const u8 = null;
    if (!is_enabled) {
        status = "disabled";
    } else if (issue) |why| {
        status = "unavailable";
        error_text = why;
    } else if (p.manifest.sidecar == null) {
        status = "ready";
    } else if (was_starting) {
        status = "starting";
    } else if (run != null) {
        status = "running";
    } else if (last_error) |e| {
        status = "error";
        error_text = e;
    } else {
        status = "stopped";
    }
    return .{
        .id = id,
        .name = p.manifest.name,
        .version = p.manifest.version,
        .description = p.manifest.description,
        .license = p.manifest.license,
        .homepage = p.manifest.homepage,
        .panel = p.manifest.panel,
        .available = issue == null,
        .mcp = p.manifest.mcp != null,
        .mcpName = if (p.manifest.mcp) |m| m.name else null,
        .source = p.source,
        .overrides = p.overrides,
        .enabled = is_enabled,
        .hasSidecar = p.manifest.sidecar != null,
        .hasSettings = settingsPath(a, p) != null,
        .autostart = autostarts(p),
        .status = status,
        .@"error" = error_text,
        .port = if (run) |r| r.port else null,
        .platforms = p.manifest.platforms,
    };
}

pub fn list(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var infos: std.ArrayList(PluginInfo) = .empty;
    for (try discover(a)) |p| try infos.append(a, try info(a, p));
    return cmd.json(output, infos.items);
}

/// The plugin's settings file (in its data folder), when it has one.
fn settingsPath(a: Allocator, p: Plugin) ?[]const u8 {
    const side = p.manifest.sidecar orelse return null;
    const rel = side.settings orelse (if (side.theme) |t| t.file else return null);
    const data = std.fmt.allocPrint(a, "{s}/plugin-data/{s}", .{ userDataDir(a) catch return null, p.manifest.id }) catch return null;
    return std.fmt.allocPrint(a, "{s}/{s}", .{ data, rel }) catch null;
}

/// The settings file for the page: plain JSON only, as base64url (the page takes it as its defaults).
fn settingsForPage(a: Allocator, p: Plugin) !?[]const u8 {
    const path = settingsPath(a, p) orelse return null;
    const raw = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(1024 * 1024)) catch return null;
    if (std.mem.trim(u8, raw, " \r\n\t").len == 0) return null;
    const value = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch {
        logLine(p.manifest.id, "[settings] the settings file is not a plain JSON object (no comments or trailing commas), so the page does not get it");
        return null;
    };
    if (value != .object) {
        logLine(p.manifest.id, "[settings] the settings file is not a plain JSON object (no comments or trailing commas), so the page does not get it");
        return null;
    }
    const compact = try std.json.Stringify.valueAlloc(a, value, .{});
    if (compact.len > 64 * 1024) {
        logLine(p.manifest.id, "[settings] the settings file is larger than 64 KB, so the page does not get it");
        return null;
    }
    const encoder = std.base64.url_safe_no_pad.Encoder;
    const out = try a.alloc(u8, encoder.calcSize(compact.len));
    return encoder.encode(out, compact);
}

/// Writes the light / dark choice into the plugin's settings file, only when it changes.
fn applyTheme(a: Allocator, id: []const u8, t: ThemeSpec, light: bool) !void {
    const path = try std.fmt.allocPrint(a, "{s}/plugin-data/{s}/{s}", .{ try userDataDir(a), id, t.file });
    const raw = std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(1024 * 1024)) catch "";
    var settings: std.json.ObjectMap = std.json.ObjectMap.empty;
    if (raw.len > 0) {
        const value = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch return error.NotPlainJson;
        if (value != .object) return error.NotPlainJson;
        settings = value.object;
    }
    const want = if (light) t.light else t.dark;
    if (settings.get(t.key)) |current| {
        if (current == .string and std.mem.eql(u8, current.string, want)) return;
    }
    try settings.put(a, t.key, .{ .string = want });
    const text = try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = settings }, .{ .whitespace = .indent_2 });
    if (std.fs.path.dirname(path)) |dir| try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = path, .data = try std.fmt.allocPrint(a, "{s}\n", .{text}) });
}

/// `{ id, light? }`: starts the plugin's sidecar if needed and returns its page address.
pub fn start(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, light: ?bool = null }, a, invocation);
    const p = (try find(a, args.id)) orelse return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    if (!isEnabled(args.id)) return cmd.fail(output, try std.fmt.allocPrint(a, "{s} is disabled (turn it on in Plugins)", .{p.manifest.name}));
    const side = p.manifest.sidecar orelse return cmd.fail(output, "this plugin has no page");
    if (side.theme) |t| if (args.light) |light| {
        applyTheme(a, args.id, t, light) catch |err| logLine(args.id, try std.fmt.allocPrint(a, "[theme] {s}", .{@errorName(err)}));
    };

    markStarting(args.id, true);
    const ep = ensure(a, p) catch |err| {
        markStarting(args.id, false);
        const message = startMessage(err);
        setError(args.id, message);
        logLine(args.id, try std.fmt.allocPrint(a, "[error] {s}", .{message}));
        return cmd.fail(output, message);
    };
    markStarting(args.id, false);
    clearError(args.id);
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}{s}", .{ ep.port, side.url });
    const settings = try settingsForPage(a, p);
    return cmd.json(output, .{ .url = url, .settings = settings });
}

fn markStarting(id: []const u8, on: bool) void {
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    ensureState();
    if (on) {
        starting.put(cmd.gpa.dupe(u8, id) catch return, {}) catch {};
    } else if (starting.fetchRemove(id)) |kv| {
        cmd.gpa.free(kv.key);
    }
}

fn startMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.PluginUnavailable => "the plugin cannot run here (see its status)",
        error.NotBuilt => "its program is not built yet",
        error.ExitedAtStart => "exited at start",
        error.DidNotAnswer => "did not answer in time",
        else => @errorName(err),
    };
}

/// `{ id }`: the path of the plugin's settings file, created (as `{}`) when it is not there yet.
pub fn settingsFile(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8 }, a, invocation);
    const p = (try find(a, args.id)) orelse return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    const path = settingsPath(a, p) orelse return cmd.fail(output, "this plugin has no settings file");
    if (!fileExists(path)) {
        if (std.fs.path.dirname(path)) |dir| try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
        try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = path, .data = "{}\n" });
    }
    return cmd.json(output, path);
}

pub fn stop(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8 }, a, invocation);
    if ((try find(a, args.id)) == null) return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    _ = stopSidecar(args.id);
    clearError(args.id);
    return cmd.json(output, null);
}

pub fn restart(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8 }, a, invocation);
    const p = (try find(a, args.id)) orelse return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    if (!isEnabled(args.id)) return cmd.fail(output, try std.fmt.allocPrint(a, "{s} is disabled", .{p.manifest.name}));
    _ = stopSidecar(args.id);
    _ = ensure(a, p) catch |err| return cmd.fail(output, startMessage(err));
    return cmd.json(output, null);
}

/// `{ id, enabled?, autostart? }`: turns the plugin on or off, and chooses whether it starts with the app.
pub fn set(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, enabled: ?bool = null, autostart: ?bool = null }, a, invocation);
    if ((try find(a, args.id)) == null) return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    try saveEntry(args.id, args.enabled, args.autostart);
    if (args.enabled == false) {
        _ = stopSidecar(args.id);
        clearError(args.id);
    }
    return cmd.json(output, null);
}

fn saveEntry(id: []const u8, enabled: ?bool, autostart: ?bool) !void {
    const p = loadPrefs();
    const entry = try pluginEntry(p, id);
    if (enabled) |on| try entry.put(p.arena.allocator(), "disabled", .{ .bool = !on });
    if (autostart) |on| try entry.put(p.arena.allocator(), "autostart", .{ .bool = on });
    try savePrefs();
}

fn savePrefs() !void {
    const p = loadPrefs();
    var scratch = std.heap.ArenaAllocator.init(cmd.gpa);
    defer scratch.deinit();
    const a = scratch.allocator();
    const text = try std.json.Stringify.valueAlloc(a, p.root, .{ .whitespace = .indent_2 });
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = try prefsPath(a), .data = text });
}

/// `{ id }`: the plugin's recent log lines.
pub fn logsFor(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8 }, a, invocation);
    state_mutex.lockUncancelable(cmd.io);
    defer state_mutex.unlock(cmd.io);
    ensureState();
    const lines: []const []const u8 = if (logs.get(args.id)) |list_value| list_value.items else &.{};
    return cmd.json(output, lines);
}

// ---------------- installing ----------------

fn validId(id: []const u8) bool {
    if (id.len == 0 or id.len > 64) return false;
    for (id) |c| {
        if (!(std.ascii.isLower(c) or std.ascii.isDigit(c) or c == '-' or c == '_')) return false;
    }
    return true;
}

fn checkManifest(a: Allocator, dir: []const u8) !Manifest {
    const raw = std.Io.Dir.cwd().readFileAlloc(cmd.io, try std.fmt.allocPrint(a, "{s}/plugin.json", .{dir}), a, .limited(1024 * 1024)) catch return error.NoManifest;
    const m = std.json.parseFromSliceLeaky(Manifest, a, raw, .{ .ignore_unknown_fields = true }) catch return error.ManifestInvalid;
    if (!validId(m.id)) return error.BadPluginId;
    if (m.sidecar) |s| {
        if (s.command.len > 0 and (s.command[0] == '/' or std.mem.indexOf(u8, s.command, "..") != null)) return error.SidecarOutsideFolder;
    }
    if (!onThisSystem(m.platforms)) return error.NoBuildForSystem;
    return m;
}

/// Copies a plugin folder into `<userData>/plugins/<id>`, replacing a previous install.
fn installDir(a: Allocator, src: []const u8) ![]const u8 {
    const m = try checkManifest(a, src);
    const plugins_dir = try userPlugins(a);
    const dest = try std.fmt.allocPrint(a, "{s}/{s}", .{ plugins_dir, m.id });
    const tmp = try std.fmt.allocPrint(a, "{s}/.{s}.new", .{ plugins_dir, m.id });
    try std.Io.Dir.cwd().createDirPath(cmd.io, plugins_dir);
    std.Io.Dir.cwd().deleteTree(cmd.io, tmp) catch {};
    try copyTree(a, src, tmp);
    _ = stopSidecar(m.id);
    std.Io.Dir.cwd().deleteTree(cmd.io, dest) catch {};
    try std.Io.Dir.rename(std.Io.Dir.cwd(), tmp, std.Io.Dir.cwd(), dest, cmd.io);
    logLine(m.id, try std.fmt.allocPrint(a, "[installed] {s} {s}", .{ m.name, m.version }));
    return m.id;
}

/// `cp -a` of a folder (keeps the executable bit and symlinks, as the Tauri build's copy keeps modes).
fn copyTree(a: Allocator, from: []const u8, to: []const u8) !void {
    const result = try std.process.run(a, cmd.io, .{ .argv = &.{ "cp", "-a", from, to } });
    if (result.term != .exited or result.term.exited != 0) return error.CopyFailed;
}

fn runTool(a: Allocator, argv: []const []const u8) !void {
    const result = try std.process.run(a, cmd.io, .{ .argv = argv, .stderr_limit = .limited(4096) });
    if (result.term != .exited or result.term.exited != 0) return error.ToolFailed;
}

/// The folder holding plugin.json: the archive's root, or its one top folder.
fn pluginRoot(a: Allocator, dir: []const u8) !?[]const u8 {
    if (fileExists(try std.fmt.allocPrint(a, "{s}/plugin.json", .{dir}))) return dir;
    var d = std.Io.Dir.cwd().openDir(cmd.io, dir, .{ .iterate = true }) catch return null;
    defer d.close(cmd.io);
    var it = d.iterate();
    while (try it.next(cmd.io)) |entry| {
        if (entry.kind != .directory) continue;
        const child = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir, entry.name });
        if (fileExists(try std.fmt.allocPrint(a, "{s}/plugin.json", .{child}))) return child;
    }
    return null;
}

/// Unpacks a .zip or .tar.gz into `out`; other files are refused.
fn extractArchive(a: Allocator, archive: []const u8, out: []const u8) !void {
    var file = try std.Io.Dir.cwd().openFile(cmd.io, archive, .{});
    defer file.close(cmd.io);
    var magic: [2]u8 = undefined;
    const n = try file.readPositionalAll(cmd.io, &magic, 0);
    if (n < 2) return error.EmptyFile;
    try std.Io.Dir.cwd().createDirPath(cmd.io, out);
    if (std.mem.eql(u8, &magic, "PK")) {
        try runTool(a, &.{ "unzip", "-q", archive, "-d", out });
    } else if (magic[0] == 0x1f and magic[1] == 0x8b) {
        try runTool(a, &.{ "tar", "-xzf", archive, "-C", out });
    } else {
        return error.UnsupportedArchive;
    }
}

fn installArchive(a: Allocator, archive: []const u8) ![]const u8 {
    const tmp = try std.fmt.allocPrint(a, "{s}/tmp/{d}", .{ try userDataDir(a), cmd.nowMs() });
    try std.Io.Dir.cwd().createDirPath(cmd.io, tmp);
    defer std.Io.Dir.cwd().deleteTree(cmd.io, tmp) catch {};
    const out = try std.fmt.allocPrint(a, "{s}/x", .{tmp});
    try extractArchive(a, archive, out);
    const root = (try pluginRoot(a, out)) orelse return error.NoManifestInArchive;
    return installDir(a, root);
}

/// `{ source, sha256? }`: installs from a folder, a .zip / .tar.gz, or an https link to one. Returns the id.
pub fn install(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { source: []const u8, sha256: ?[]const u8 = null }, a, invocation);
    const source = std.mem.trim(u8, args.source, " \r\n\t");
    if (source.len == 0) return cmd.fail(output, "give a folder, an archive or a link");

    const id = blk: {
        if (std.mem.startsWith(u8, source, "https://") or std.mem.startsWith(u8, source, "http://")) {
            const tmp = try std.fmt.allocPrint(a, "{s}/tmp/dl-{d}", .{ try userDataDir(a), cmd.nowMs() });
            try std.Io.Dir.cwd().createDirPath(cmd.io, tmp);
            defer std.Io.Dir.cwd().deleteTree(cmd.io, tmp) catch {};
            const archive = try std.fmt.allocPrint(a, "{s}/archive", .{tmp});
            downloadArchive(a, source, archive, args.sha256) catch |err| return cmd.fail(output, @errorName(err));
            break :blk installArchive(a, archive) catch |err| return cmd.fail(output, @errorName(err));
        }
        if (dirExists(source)) break :blk installDir(a, source) catch |err| return cmd.fail(output, @errorName(err));
        if (fileExists(source)) break :blk installArchive(a, source) catch |err| return cmd.fail(output, @errorName(err));
        return cmd.fail(output, try std.fmt.allocPrint(a, "{s} is not a folder or a file", .{source}));
    };

    // installing again brings back a plugin removed from the app
    try saveRemoved(id, false);
    return cmd.json(output, id);
}

fn saveRemoved(id: []const u8, removed: bool) !void {
    const p = loadPrefs();
    const entry = try pluginEntry(p, id);
    try entry.put(p.arena.allocator(), "removed", .{ .bool = removed });
    try savePrefs();
}

fn downloadArchive(a: Allocator, url: []const u8, path: []const u8, sha256: ?[]const u8) !void {
    if (!std.mem.startsWith(u8, url, "https://") and !std.mem.startsWith(u8, url, "http://127.0.0.1") and !std.mem.startsWith(u8, url, "http://localhost")) {
        return error.NotHttps;
    }
    try runTool(a, &.{ "curl", "-fsSL", "--max-time", "600", "--max-filesize", "629145600", "-o", path, url });
    if (sha256) |want_raw| {
        const want = std.mem.trim(u8, want_raw, " \r\n\t");
        if (want.len == 0) return;
        const got = try sha256File(a, path);
        if (!std.ascii.eqlIgnoreCase(got, want)) return error.ChecksumMismatch;
    }
}

fn sha256File(a: Allocator, path: []const u8) ![]const u8 {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(cmd.io, path, a, .limited(max_download_bytes));
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const out = try a.alloc(u8, 64);
    for (digest, 0..) |b, i| _ = std.fmt.bufPrint(out[i * 2 .. i * 2 + 2], "{x:0>2}", .{b}) catch unreachable;
    return out;
}

/// `{ id, purge }`: removes a plugin the user installed (purge also deletes its data). A shipped or
/// development one is only hidden: its files stay, and installing it again brings it back.
pub fn uninstall(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, purge: bool = false }, a, invocation);
    const p = (try find(a, args.id)) orelse return cmd.fail(output, try std.fmt.allocPrint(a, "no plugin \"{s}\"", .{args.id}));
    _ = stopSidecar(args.id);
    const user_dir = try userPlugins(a);
    if (p.source == .user and std.mem.startsWith(u8, p.dir, user_dir)) {
        std.Io.Dir.cwd().deleteTree(cmd.io, p.dir) catch return cmd.fail(output, "could not remove it");
        if (args.purge) {
            const data = try std.fmt.allocPrint(a, "{s}/plugin-data/{s}", .{ try userDataDir(a), args.id });
            std.Io.Dir.cwd().deleteTree(cmd.io, data) catch {};
        }
        const prefs = loadPrefs();
        if (prefsObject(prefs).getPtr("plugins")) |plugins| _ = plugins.object.swapRemove(args.id);
        try savePrefs();
    } else {
        try saveRemoved(args.id, true);
    }
    clearError(args.id);
    state_mutex.lockUncancelable(cmd.io);
    ensureState();
    if (logs.fetchRemove(args.id)) |kv| {
        cmd.gpa.free(kv.key);
        for (kv.value.items) |line| cmd.gpa.free(line);
        var list_value = kv.value;
        list_value.deinit(cmd.gpa);
    }
    state_mutex.unlock(cmd.io);
    return cmd.json(output, null);
}

// ---------------- registry ----------------

const RegistryEntry = struct {
    id: []const u8,
    name: []const u8,
    version: []const u8 = "",
    description: []const u8 = "",
    license: []const u8 = "",
    homepage: []const u8 = "",
    url: []const u8,
    sha256: ?[]const u8 = null,
    min_app_version: []const u8 = "",
    platforms: []const []const u8 = &.{},
};

fn registryUrl(a: Allocator) ![]const u8 {
    const p = loadPrefs();
    if (prefsObject(p).get("registry")) |value| {
        if (value == .string and std.mem.trim(u8, value.string, " \t").len > 0) return a.dupe(u8, value.string);
    }
    return a.dupe(u8, default_registry);
}

/// `{}`: the plugins on offer, from the registry's index.json.
pub fn registry(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const url = try registryUrl(a);
    if (!std.mem.startsWith(u8, url, "https://") and !std.mem.startsWith(u8, url, "http://127.0.0.1") and !std.mem.startsWith(u8, url, "http://localhost")) {
        return cmd.fail(output, "the registry must be an https link");
    }
    const result = std.process.run(a, cmd.io, .{ .argv = &.{ "curl", "-fsSL", "--max-time", "15", url }, .stdout_limit = .limited(8 * 1024 * 1024) }) catch
        return cmd.fail(output, "could not reach the registry");
    if (result.term != .exited or result.term.exited != 0) return cmd.fail(output, "could not reach the registry");
    const File = struct { plugins: []const RegistryEntry = &.{} };
    const file = std.json.parseFromSliceLeaky(File, a, result.stdout, .{ .ignore_unknown_fields = true }) catch
        return cmd.fail(output, "the registry is not a valid index.json");

    var entries: std.ArrayList(struct { entry: RegistryEntry, compatible: bool }) = .empty;
    for (file.plugins) |e| {
        if (!validId(e.id)) continue;
        const compatible = onThisSystem(e.platforms) and (e.min_app_version.len == 0 or !newer(e.min_app_version, app_version));
        try entries.append(a, .{ .entry = e, .compatible = compatible });
    }
    return cmd.json(output, .{ .url = url, .entries = entries.items });
}

/// `{ set? }`: the registry address in use. A set value changes it; an empty one goes back to the default.
pub fn registryUrlCommand(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { set: ?[]const u8 = null }, a, invocation);
    if (args.set) |raw| {
        const trimmed = std.mem.trim(u8, raw, " \r\n\t");
        const p = loadPrefs();
        if (trimmed.len == 0) {
            _ = prefsObject(p).swapRemove("registry");
        } else {
            try prefsObject(p).put(p.arena.allocator(), "registry", .{ .string = try p.arena.allocator().dupe(u8, trimmed) });
        }
        try savePrefs();
    }
    return cmd.json(output, try registryUrl(a));
}
