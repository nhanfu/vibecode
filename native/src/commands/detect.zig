//! What the chat needs to know about the machine: whether Claude Code is installed, and the user's shell.
//! Port of claude_detect in src-tauri/src/pty.rs. Only the PATH lookup is ported (the Windows install spots are not).

const std = @import("std");
const cmd = @import("root.zig");

/// The first executable called `name` on $PATH, copied into `a`.
pub fn which(a: std.mem.Allocator, name: []const u8) !?[]const u8 {
    const path_env = std.mem.span(std.c.getenv("PATH") orelse return null);
    var dirs = std.mem.splitScalar(u8, path_env, ':');
    while (dirs.next()) |dir| {
        if (dir.len == 0) continue;
        const candidate = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir, name });
        const z = try a.dupeZ(u8, candidate);
        if (std.c.access(z.ptr, std.c.X_OK) != 0) continue;
        return candidate;
    }
    return null;
}

fn defaultShell() []const u8 {
    if (std.c.getenv("SHELL")) |raw| return std.mem.span(raw);
    return "/bin/bash";
}

pub fn claudeDetect(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const found = try which(a, "claude");
    return cmd.json(output, .{
        .found = found != null,
        .path = found,
        .shell = defaultShell(),
    });
}

const agents = [_]struct { id: []const u8, command: []const u8 }{
    .{ .id = "claude", .command = "claude" },
    .{ .id = "codex", .command = "codex" },
    .{ .id = "grok", .command = "grok" },
    .{ .id = "gemini", .command = "gemini" },
    .{ .id = "qwen", .command = "qwen" },
    .{ .id = "copilot", .command = "copilot" },
    .{ .id = "opencode", .command = "opencode" },
};

pub fn agentsDetect(_: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var infos: [agents.len]struct { id: []const u8, found: bool } = undefined;
    for (agents, 0..) |agent, index| {
        infos[index] = .{ .id = agent.id, .found = (try which(a, agent.command)) != null };
    }
    return cmd.json(output, infos);
}
