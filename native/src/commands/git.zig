//! Git through the `git` CLI, so the user's own config, credentials and hooks apply.
//! Port of src-tauri/src/git.rs. Each handler works in one arena, freed when the handler returns.

const std = @import("std");
const cmd = @import("root.zig");

const Allocator = std.mem.Allocator;

var last_error_buffer: [4096]u8 = undefined;
var last_error: []const u8 = "";
var fresh_review_done = false;

const GitError = error{GitFailed};

/// Runs `git <args>` in `cwd`; returns its stdout. On failure the trimmed stderr is kept in `last_error`.
fn git(a: Allocator, cwd: []const u8, args: []const []const u8) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(a, "git");
    try argv.appendSlice(a, args);
    const result = try std.process.run(a, cmd.io, .{
        .argv = argv.items,
        .cwd = .{ .path = cwd },
        .stdout_limit = .limited(16 * 1024 * 1024),
        .stderr_limit = .limited(64 * 1024),
    });
    switch (result.term) {
        .exited => |code| if (code == 0) return result.stdout,
        else => {},
    }
    const message = std.mem.trim(u8, result.stderr, " \r\n\t");
    const n = @min(message.len, last_error_buffer.len);
    @memcpy(last_error_buffer[0..n], message[0..n]);
    last_error = last_error_buffer[0..n];
    return GitError.GitFailed;
}

/// git's stdout as text the JSON writer accepts.
fn text(a: Allocator, cwd: []const u8, args: []const []const u8) ![]u8 {
    return cmd.lossy(a, try git(a, cwd, args));
}

fn trimmed(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \r\n\t");
}

const Stat = struct { added: u32 = 0, deleted: u32 = 0 };
const StatMap = std.StringHashMap(Stat);

/// `added\tdeleted\tpath` records of `--numstat -z`, summed per path.
fn numstats(a: Allocator, outs: []const []const u8) !StatMap {
    var stats = StatMap.init(a);
    for (outs) |out| {
        var records = std.mem.splitScalar(u8, out, 0);
        while (records.next()) |rec| {
            var it = std.mem.splitScalar(u8, rec, '\t');
            const added = it.next() orelse continue;
            const deleted = it.next() orelse continue;
            const path = it.rest();
            if (path.len == 0) continue;
            const entry = try stats.getOrPut(path);
            if (!entry.found_existing) entry.value_ptr.* = .{};
            entry.value_ptr.added += std.fmt.parseInt(u32, added, 10) catch 0;
            entry.value_ptr.deleted += std.fmt.parseInt(u32, deleted, 10) catch 0;
        }
    }
    return stats;
}

const Args = struct { folder: []const u8 = "" };

const GitFile = struct {
    rel: []const u8,
    abs: []const u8,
    status: []const u8,
    staged: bool,
    added: u32,
    deleted: u32,
};

const GitState = struct {
    isRepo: bool,
    root: ?[]const u8,
    branch: ?[]const u8,
    files: []const GitFile,
};

fn notRepo(output: []u8) ![]const u8 {
    return cmd.json(output, GitState{ .isRepo = false, .root = null, .branch = null, .files = &.{} });
}

pub fn state(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(Args, a, invocation);

    const root = trimmed(git(a, args.folder, &.{ "rev-parse", "--show-toplevel" }) catch return notRepo(output));
    const root_copy = try a.dupe(u8, root);

    const branch_raw = git(a, root_copy, &.{ "branch", "--show-current" }) catch "";
    // no index refresh: that write fires the watcher, which runs yet another status
    const status = git(a, root_copy, &.{ "--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall" }) catch "";
    const unstaged = git(a, root_copy, &.{ "diff", "--numstat", "-z" }) catch "";
    const staged_stats = git(a, root_copy, &.{ "diff", "--numstat", "--cached", "-z" }) catch "";
    var stats = try numstats(a, &.{ unstaged, staged_stats });

    var files: std.ArrayList(GitFile) = .empty;
    var records = std.mem.splitScalar(u8, status, 0);
    while (records.next()) |rec| {
        if (rec.len < 4) continue;
        const x = rec[0];
        const y = rec[1];
        const rel = rec[3..];
        if (x == 'R' or x == 'C') _ = records.next();
        const code: []const u8 = if (x == '?' and y == '?')
            "?"
        else if (x == 'U' or y == 'U')
            "U"
        else if (x == 'D' or y == 'D')
            "D"
        else if (x == 'A')
            "A"
        else if (x == 'R')
            "R"
        else
            "M";
        const stat = stats.get(rel) orelse Stat{};
        try files.append(a, .{
            .abs = try std.fs.path.join(a, &.{ root_copy, rel }),
            .rel = rel,
            .status = code,
            .staged = x != ' ' and x != '?',
            .added = stat.added,
            .deleted = stat.deleted,
        });
    }
    std.mem.sort(GitFile, files.items, {}, struct {
        fn less(_: void, l: GitFile, r: GitFile) bool {
            return std.mem.lessThan(u8, l.rel, r.rel);
        }
    }.less);

    const branch_name = trimmed(branch_raw);
    return cmd.json(output, GitState{
        .isRepo = true,
        .root = root_copy,
        .branch = if (branch_name.len == 0) "HEAD" else branch_name,
        .files = files.items,
    });
}

const Ignored = struct { root: ?[]const u8, paths: []const []const u8 };

/// Untracked paths that .gitignore matches, relative to the repo root. A folder ends with "/" and stands for everything under it.
pub fn ignored(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(Args, a, invocation);

    const root = trimmed(git(a, args.folder, &.{ "rev-parse", "--show-toplevel" }) catch return cmd.json(output, Ignored{ .root = null, .paths = &.{} }));
    const root_copy = try a.dupe(u8, root);
    const listed = git(a, root_copy, &.{ "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z" }) catch "";
    var paths: std.ArrayList([]const u8) = .empty;
    var records = std.mem.splitScalar(u8, listed, 0);
    while (records.next()) |rec| {
        if (rec.len == 0) continue;
        try paths.append(a, try a.dupe(u8, rec));
    }
    return cmd.json(output, Ignored{ .root = root_copy, .paths = paths.items });
}

const RootRel = struct { root: []const u8, rel: []const u8 };

/// File content at HEAD; "" when it does not exist there.
pub fn original(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RootRel, a, invocation);
    const spec = try std.fmt.allocPrint(a, "HEAD:{s}", .{args.rel});
    const body = text(a, args.root, &.{ "show", spec }) catch "";
    return cmd.json(output, body);
}

pub fn init(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(Args, a, invocation);
    _ = git(a, args.folder, &.{"init"}) catch return cmd.fail(output, last_error);
    return cmd.json(output, null);
}

/// A revision goes in front of `:path` in one argument: one starting with `-` would be read as an option.
fn plainRev(rev: []const u8) bool {
    return rev.len > 0 and rev[0] != '-';
}

const RevRel = struct { root: []const u8, rev: []const u8, rel: []const u8 };

pub fn show(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RevRel, a, invocation);
    if (!plainRev(args.rev)) return cmd.fail(output, "not a revision");
    const spec = try std.fmt.allocPrint(a, "{s}:{s}", .{ args.rev, args.rel });
    const body = text(a, args.root, &.{ "show", spec }) catch "";
    return cmd.json(output, body);
}

/// Whether `rel` is a plain relative path: no root, no `.` or `..` parts (Rust's `Component::Normal` only).
fn plainRelPath(rel: []const u8) bool {
    if (rel.len == 0 or rel[0] == '/') return false;
    var parts = std.mem.splitScalar(u8, rel, '/');
    while (parts.next()) |part| {
        if (std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return false;
    }
    return true;
}

const SnapshotArgs = struct { root: []const u8, rev: []const u8, rel: []const u8, label: []const u8 };

/// A file as it was at `rev`, written to `<userData>/review/<label>/<rel>` so another editor can open it.
/// The review folder is emptied the first time this runs after the app starts.
pub fn snapshot(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(SnapshotArgs, a, invocation);

    var dir_buffer: [4096]u8 = undefined;
    const base = try std.fmt.allocPrint(a, "{s}/review", .{try cmd.userData(&dir_buffer)});
    if (!fresh_review_done) {
        fresh_review_done = true;
        std.Io.Dir.cwd().deleteTree(cmd.io, base) catch {};
    }

    var label_ok = args.label.len > 0;
    for (args.label) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_')) label_ok = false;
    }
    if (!plainRelPath(args.rel) or !label_ok) return cmd.fail(output, "not a path inside the repository");
    if (!plainRev(args.rev)) return cmd.fail(output, "not a revision");

    const spec = try std.fmt.allocPrint(a, "{s}:{s}", .{ args.rev, args.rel });
    const content = text(a, args.root, &.{ "show", spec }) catch "";
    const file = try std.fmt.allocPrint(a, "{s}/{s}/{s}", .{ base, args.label, args.rel });
    if (std.fs.path.dirname(file)) |dir| {
        try std.Io.Dir.cwd().createDirPath(cmd.io, dir);
    }
    try std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = content });
    return cmd.json(output, file);
}

const Commit = struct {
    hash: []const u8,
    short: []const u8,
    author: []const u8,
    date: u64,
    subject: []const u8,
};

const RootArg = struct { root: []const u8 };

pub fn log(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RootArg, a, invocation);

    const out = text(a, args.root, &.{ "log", "-n200", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e" }) catch
        return cmd.json(output, @as([]const Commit, &.{}));
    var commits: std.ArrayList(Commit) = .empty;
    var records = std.mem.splitScalar(u8, out, 0x1e);
    while (records.next()) |raw| {
        var fields = std.mem.splitScalar(u8, std.mem.trimStart(u8, raw, " \r\n\t"), 0x1f);
        const hash = fields.next() orelse continue;
        const short = fields.next() orelse continue;
        if (hash.len == 0 or short.len == 0) continue;
        const author = fields.next() orelse "";
        const at = std.fmt.parseInt(u64, fields.next() orelse "", 10) catch 0;
        const subject = fields.next() orelse "";
        try commits.append(a, .{ .hash = hash, .short = short, .author = author, .date = at * 1000, .subject = subject });
    }
    return cmd.json(output, commits.items);
}

const CommitFile = struct { rel: []const u8, status: []const u8, added: u32, deleted: u32 };

pub fn commitFiles(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { root: []const u8, hash: []const u8 }, a, invocation);

    const names = text(a, args.root, &.{ "diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "-z", "--name-status", args.hash }) catch "";
    const nums = text(a, args.root, &.{ "diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "-z", "--numstat", args.hash }) catch "";
    var stats = try numstats(a, &.{nums});

    var parts: std.ArrayList([]const u8) = .empty;
    var records = std.mem.splitScalar(u8, names, 0);
    while (records.next()) |part| try parts.append(a, part);

    var files: std.ArrayList(CommitFile) = .empty;
    var i: usize = 0;
    while (i + 1 < parts.items.len) : (i += 2) {
        const code_text = parts.items[i];
        const rel = parts.items[i + 1];
        if (code_text.len == 0 or rel.len == 0) continue;
        const status: []const u8 = switch (code_text[0]) {
            'A' => "A",
            'D' => "D",
            'U' => "U",
            else => "M",
        };
        const stat = stats.get(rel) orelse Stat{};
        try files.append(a, .{ .rel = rel, .status = status, .added = stat.added, .deleted = stat.deleted });
    }
    return cmd.json(output, files.items);
}

const Branch = struct { name: []const u8, current: bool, remote: bool };

/// Local branches, then remote ones that have no local branch of the same name.
pub fn branches(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RootArg, a, invocation);

    const out = git(a, args.root, &.{ "for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(HEAD)", "refs/heads", "refs/remotes" }) catch
        return cmd.fail(output, last_error);
    var local: std.ArrayList(Branch) = .empty;
    var remote: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.splitScalar(u8, out, '\n');
    while (lines.next()) |line| {
        const sep = std.mem.indexOfScalar(u8, line, 0x1f) orelse continue;
        const refname = line[0..sep];
        const head = line[sep + 1 ..];
        if (std.mem.startsWith(u8, refname, "refs/heads/")) {
            try local.append(a, .{ .name = refname["refs/heads/".len..], .current = std.mem.eql(u8, head, "*"), .remote = false });
        } else if (std.mem.startsWith(u8, refname, "refs/remotes/")) {
            const name = refname["refs/remotes/".len..];
            if (!std.mem.endsWith(u8, name, "/HEAD")) try remote.append(a, name);
        }
    }
    for (remote.items) |name| {
        const short = if (std.mem.indexOfScalar(u8, name, '/')) |slash| name[slash + 1 ..] else name;
        var known = false;
        for (local.items) |b| {
            if (std.mem.eql(u8, b.name, short) or std.mem.eql(u8, b.name, name)) known = true;
        }
        if (!known) try local.append(a, .{ .name = name, .current = false, .remote = true });
    }
    return cmd.json(output, local.items);
}

const CheckoutArgs = struct { root: []const u8, name: []const u8, remote: bool = false };

/// Switch to a branch; a remote one (`origin/x`) becomes local `x` tracking it.
pub fn checkout(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(CheckoutArgs, a, invocation);

    if (args.remote) {
        const local = if (std.mem.indexOfScalar(u8, args.name, '/')) |slash| args.name[slash + 1 ..] else args.name;
        _ = git(a, args.root, &.{ "switch", "-c", local, "--track", args.name }) catch return cmd.fail(output, last_error);
    } else {
        _ = git(a, args.root, &.{ "switch", args.name }) catch return cmd.fail(output, last_error);
    }
    return cmd.json(output, null);
}

/// The error git printed, or `fallback` when it printed nothing (`git commit` says "nothing to commit" on stdout).
fn failure(fallback: []const u8) []const u8 {
    return if (last_error.len > 0) last_error else fallback;
}

const CommitArgs = struct { root: []const u8, message: []const u8, stageAll: bool = true };

/// Commits the folder's changes; `stageAll` adds every change first (git add -A), else only what is staged.
pub fn commit(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(CommitArgs, a, invocation);
    if (trimmed(args.message).len == 0) return cmd.fail(output, "write a commit message first");
    if (args.stageAll) _ = git(a, args.root, &.{ "add", "-A" }) catch return cmd.fail(output, failure("could not stage the changes"));
    _ = git(a, args.root, &.{ "commit", "-m", args.message }) catch return cmd.fail(output, failure("nothing to commit"));
    return cmd.json(output, null);
}

const RootArgs = struct { root: []const u8 };

/// Pushes the current branch; a branch with no upstream yet is published to origin.
pub fn push(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RootArgs, a, invocation);
    _ = git(a, args.root, &.{"push"}) catch {
        _ = git(a, args.root, &.{ "push", "-u", "origin", "HEAD" }) catch return cmd.fail(output, failure("push failed"));
    };
    return cmd.json(output, null);
}

const FileArgs = struct { root: []const u8, rel: []const u8 };

/// The changes of one tracked file against HEAD (staged and not), as a unified diff.
pub fn diff(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(FileArgs, a, invocation);
    if (!plainRelPath(args.rel)) return cmd.fail(output, "not a path in this folder");
    const body = text(a, args.root, &.{ "diff", "--no-color", "HEAD", "--", args.rel }) catch return cmd.fail(output, failure("no diff"));
    return cmd.json(output, body);
}

const RevertArgs = struct { root: []const u8, rel: []const u8, untracked: bool = false };

/// Throws away one file's changes: back to HEAD, or removed when it is new (untracked or only added).
pub fn revertFile(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RevertArgs, a, invocation);
    if (!plainRelPath(args.rel)) return cmd.fail(output, "not a path in this folder");
    if (args.untracked) {
        _ = git(a, args.root, &.{ "clean", "-fd", "--", args.rel }) catch return cmd.fail(output, failure("could not remove the file"));
    } else {
        _ = git(a, args.root, &.{ "restore", "--source=HEAD", "--staged", "--worktree", "--", args.rel }) catch {
            _ = git(a, args.root, &.{ "rm", "-f", "--", args.rel }) catch return cmd.fail(output, failure("could not revert the file"));
        };
    }
    return cmd.json(output, null);
}

/// Throws away every change of the folder: tracked files back to HEAD, untracked files removed.
pub fn revertAll(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(RootArgs, a, invocation);
    _ = git(a, args.root, &.{ "restore", "--source=HEAD", "--staged", "--worktree", "--", "." }) catch return cmd.fail(output, failure("could not revert the changes"));
    _ = git(a, args.root, &.{ "clean", "-fd" }) catch return cmd.fail(output, failure("could not remove new files"));
    return cmd.json(output, null);
}
