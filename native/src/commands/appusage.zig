//! What the app itself uses: the app process, the terminal service (ptyd) it started, and every process
//! under them (the chats' shells and their claude / agent processes). Read from /proc, so Linux only;
//! elsewhere the answer is null and the status bar hides the item.

const std = @import("std");
const builtin = @import("builtin");
const cmd = @import("root.zig");

/// Linux reports process CPU time in clock ticks of USER_HZ, which is 100 on every Linux build.
const ticks_per_second: f64 = 100;
const page_bytes: u64 = 4096;

extern "c" fn fopen(path: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
extern "c" fn fread(ptr: [*]u8, size: usize, count: usize, stream: *anyopaque) usize;
extern "c" fn fclose(stream: *anyopaque) c_int;

/// Reads a /proc file to its end (its reported size is 0, so std's size-based readers return nothing).
fn readProcFile(a: std.mem.Allocator, path: []const u8, max: usize) ?[]u8 {
    const z = a.dupeZ(u8, path) catch return null;
    const file = fopen(z.ptr, "r") orelse return null;
    defer _ = fclose(file);
    const buf = a.alloc(u8, max) catch return null;
    const n = fread(buf.ptr, 1, max, file);
    return buf[0..n];
}

const Sample = struct {
    cpu_ticks: u64,
    wall_ns: i128,
};

var previous: ?Sample = null;

const Proc = struct {
    pid: u32,
    ppid: u32,
    ticks: u64,
    rss_pages: u64,
    is_ptyd: bool,
};

fn monotonicNs() i128 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(.MONOTONIC, &ts);
    return @as(i128, ts.sec) * std.time.ns_per_s + ts.nsec;
}

/// Reads one /proc/<pid>/stat line into the process record (fields after the parenthesised command name).
fn readProc(a: std.mem.Allocator, pid: u32, self_exe: []const u8) ?Proc {
    const stat_path = std.fmt.allocPrint(a, "/proc/{d}/stat", .{pid}) catch return null;
    const stat = readProcFile(a, stat_path, 4096) orelse return null;
    const close = std.mem.lastIndexOfScalar(u8, stat, ')') orelse return null;
    var fields = std.mem.tokenizeScalar(u8, stat[close + 1 ..], ' ');
    // after ")": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
    _ = fields.next() orelse return null;
    const ppid = std.fmt.parseInt(u32, fields.next() orelse return null, 10) catch return null;
    var index: usize = 2;
    var utime: u64 = 0;
    var stime: u64 = 0;
    var rss: u64 = 0;
    while (fields.next()) |field| : (index += 1) {
        switch (index) {
            11 => utime = std.fmt.parseInt(u64, field, 10) catch 0,
            12 => stime = std.fmt.parseInt(u64, field, 10) catch 0,
            21 => rss = std.fmt.parseInt(u64, field, 10) catch 0,
            else => {},
        }
    }
    // the terminal service is this same executable started with --ptyd
    var is_ptyd = false;
    const exe_path = std.fmt.allocPrint(a, "/proc/{d}/exe", .{pid}) catch return null;
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    if (std.Io.Dir.readLinkAbsolute(cmd.io, exe_path, &buf)) |n| {
        if (std.mem.eql(u8, buf[0..n], self_exe)) {
            const line_path = std.fmt.allocPrint(a, "/proc/{d}/cmdline", .{pid}) catch return null;
            if (readProcFile(a, line_path, 4096)) |line| {
                is_ptyd = std.mem.indexOf(u8, line, "--ptyd") != null;
            }
        }
    } else |_| {}
    return .{ .pid = pid, .ppid = ppid, .ticks = utime + stime, .rss_pages = rss, .is_ptyd = is_ptyd };
}

/// `{cpuPercent, rssBytes, processes}`: CPU is the share of the whole machine since the previous call
/// (null on the first call), memory is the resident size of the processes.
pub fn appUsage(_: cmd.Invocation, output: []u8) ![]const u8 {
    if (builtin.os.tag != .linux) return cmd.json(output, @as(?u8, null));
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    var self_buf: [std.fs.max_path_bytes]u8 = undefined;
    const self_exe_len = std.Io.Dir.readLinkAbsolute(cmd.io, "/proc/self/exe", &self_buf) catch return cmd.json(output, @as(?u8, null));
    const self_exe = self_buf[0..self_exe_len];
    const self_pid: u32 = @intCast(std.c.getpid());

    var procs: std.ArrayList(Proc) = .empty;
    var proc_dir = std.Io.Dir.openDirAbsolute(cmd.io, "/proc", .{ .iterate = true }) catch return cmd.json(output, @as(?u8, null));
    defer proc_dir.close(cmd.io);
    var it = proc_dir.iterate();
    while (it.next(cmd.io) catch null) |entry| {
        const pid = std.fmt.parseInt(u32, entry.name, 10) catch continue;
        if (readProc(a, pid, self_exe)) |p| try procs.append(a, p);
    }

    // the app and the terminal service it started, then everything they started (repeat until nothing is added)
    var inside = try a.alloc(bool, procs.items.len);
    @memset(inside, false);
    for (procs.items, 0..) |p, i| {
        if (p.pid == self_pid or p.is_ptyd) inside[i] = true;
    }
    var changed = true;
    while (changed) {
        changed = false;
        for (procs.items, 0..) |p, i| {
            if (inside[i]) continue;
            for (procs.items, 0..) |q, j| {
                if (inside[j] and q.pid == p.ppid) {
                    inside[i] = true;
                    changed = true;
                    break;
                }
            }
        }
    }

    var ticks: u64 = 0;
    var rss_pages: u64 = 0;
    var count: u64 = 0;
    for (procs.items, 0..) |p, i| {
        if (!inside[i]) continue;
        ticks += p.ticks;
        rss_pages += p.rss_pages;
        count += 1;
    }

    const now = monotonicNs();
    var cpu_percent: ?f64 = null;
    if (previous) |prev| {
        const wall_s = @as(f64, @floatFromInt(now - prev.wall_ns)) / std.time.ns_per_s;
        const cpu_s = @as(f64, @floatFromInt(ticks -| prev.cpu_ticks)) / ticks_per_second;
        const cores = @as(f64, @floatFromInt(std.Thread.getCpuCount() catch 1));
        if (wall_s > 0) cpu_percent = cpu_s / wall_s / cores * 100;
    }
    previous = .{ .cpu_ticks = ticks, .wall_ns = now };

    return cmd.json(output, .{
        .cpuPercent = cpu_percent,
        .rssBytes = rss_pages * page_bytes,
        .processes = count,
    });
}
