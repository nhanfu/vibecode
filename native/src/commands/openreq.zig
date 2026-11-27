//! Claude opens a page in a chat's Web tab by running `vibe-open <url> [--headless]` in its shell, no MCP
//! needed. `vibe-open` is a script in the data folder's bin/ (first on PATH in every chat) that runs this
//! executable with `--open-tab`: it sends {chatId, url, headless} to the app over a Unix socket in the data
//! folder. The chat id is TINJS_PTY_ID, which every chat's terminal already has. The app emits each request
//! as the 'browser:tab-request' event; the page opens the tab (openBrowserTab in actions.ts).

const std = @import("std");
const cmd = @import("root.zig");
const ptyd = @import("ptyd.zig");

const socket_name = "open-tab.sock";
const helper_name = "vibe-open";
const max_request = 8192;

var app_exe: []const u8 = "";
var started = false;

/// The folder the helper lives in: put first on PATH in every chat (see childEnv in pty.zig).
pub fn binDir(buf: []u8) ?[]const u8 {
    var dir_buf: [512]u8 = undefined;
    const base = cmd.userData(&dir_buf) catch return null;
    return std.fmt.bufPrint(buf, "{s}/bin", .{base}) catch null;
}

/// The path of the app executable, for TINJS_APP_BIN in every chat (the helper runs it).
pub fn appExe() []const u8 {
    return app_exe;
}

fn socketPath() ?[:0]const u8 {
    const S = struct {
        var dir_buf: [512]u8 = undefined;
        var path_buf: [600]u8 = undefined;
    };
    const dir = cmd.userData(&S.dir_buf) catch return null;
    return std.fmt.bufPrintZ(&S.path_buf, "{s}/{s}", .{ dir, socket_name }) catch null;
}

/// Starts the listener and writes the helper. Called once when the app starts; later calls do nothing.
pub fn start() void {
    if (started) return;
    started = true;
    app_exe = std.process.executablePathAlloc(cmd.io, cmd.gpa) catch "";
    writeHelper();
    const path = socketPath() orelse return;
    _ = std.c.unlink(path.ptr);
    const listener = std.c.socket(std.c.AF.UNIX, std.c.SOCK.STREAM, 0);
    if (listener < 0) return;
    const addr = ptyd.unixAddress(path) orelse return;
    if (std.c.bind(listener, @ptrCast(&addr), @sizeOf(std.c.sockaddr.un)) != 0) return;
    if (std.c.listen(listener, 8) != 0) return;
    const thread = std.Thread.spawn(.{}, acceptLoop, .{listener}) catch return;
    thread.detach();
}

fn writeHelper() void {
    var dir_buf: [700]u8 = undefined;
    const dir = binDir(&dir_buf) orelse return;
    std.Io.Dir.cwd().createDirPath(cmd.io, dir) catch return;
    var file_buf: [800]u8 = undefined;
    const file = std.fmt.bufPrint(&file_buf, "{s}/{s}", .{ dir, helper_name }) catch return;
    // the helper runs this same app: TINJS_APP_BIN is the executable the app was started from (see childEnv)
    const script = "#!/bin/sh\nexec \"$TINJS_APP_BIN\" --open-tab \"$@\"\n";
    std.Io.Dir.cwd().writeFile(cmd.io, .{ .sub_path = file, .data = script }) catch return;
    var z: [800]u8 = undefined;
    const zfile = std.fmt.bufPrintZ(&z, "{s}", .{file}) catch return;
    _ = std.c.chmod(zfile.ptr, 0o755);
}

fn acceptLoop(listener: c_int) void {
    while (true) {
        const fd = std.c.accept(listener, null, null);
        if (fd < 0) continue;
        const thread = std.Thread.spawn(.{}, serve, .{fd}) catch {
            _ = std.c.close(fd);
            continue;
        };
        thread.detach();
    }
}

const Request = struct {
    chatId: []const u8,
    url: []const u8,
    headless: bool = false,
};

/// One request per connection: a JSON line in, "ok" or an error line out.
fn serve(fd: c_int) void {
    defer _ = std.c.close(fd);
    var buf: [max_request]u8 = undefined;
    var len: usize = 0;
    while (len < buf.len) {
        const n = std.c.read(fd, buf[len..].ptr, buf.len - len);
        if (n <= 0) break;
        len += @intCast(n);
        if (std.mem.indexOfScalar(u8, buf[0..len], '\n') != null) break;
    }
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const line = std.mem.trim(u8, buf[0..len], " \r\n");
    const req = std.json.parseFromSliceLeaky(Request, a, line, .{ .ignore_unknown_fields = true }) catch {
        reply(fd, "error: bad request\n");
        return;
    };
    if (!(std.mem.startsWith(u8, req.url, "http://") or std.mem.startsWith(u8, req.url, "https://")) or req.url.len > 2048) {
        reply(fd, "error: only http and https addresses\n");
        return;
    }
    if (req.chatId.len == 0 or req.chatId.len > 128) {
        reply(fd, "error: no chat\n");
        return;
    }
    const json = std.json.Stringify.valueAlloc(a, .{ req.chatId, req.url, req.headless }, .{}) catch return;
    cmd.emit("browser:tab-request", json);
    reply(fd, "ok\n");
}

fn reply(fd: c_int, text: []const u8) void {
    _ = std.c.write(fd, text.ptr, text.len);
}

/// `vibe-code --open-tab <url> [--headless]`: the helper's side. Prints the app's answer; exit 0 when opened.
pub fn client(args: std.process.Args) void {
    var it = args.iterate();
    _ = it.next(); // program name
    var url: ?[]const u8 = null;
    var headless = false;
    while (it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--open-tab")) continue;
        if (std.mem.eql(u8, arg, "--headless")) headless = true else url = arg;
    }
    const chat = std.c.getenv("TINJS_PTY_ID");
    const target = url orelse {
        std.debug.print("usage: vibe-open <url> [--headless]\n", .{});
        std.process.exit(2);
    };
    if (chat == null) {
        std.debug.print("vibe-open works in a VIBE CODE chat only (no TINJS_PTY_ID)\n", .{});
        std.process.exit(2);
    }
    // the URL goes into the JSON unescaped: quotes and backslashes are not valid in a link anyway
    for (target) |ch| if (ch == '"' or ch == '\\' or ch < 0x20) {
        std.debug.print("this address cannot be opened\n", .{});
        std.process.exit(2);
    };
    const path = socketPath() orelse std.process.exit(2);
    const fd = ptyd.connectSocket(path) orelse {
        std.debug.print("VIBE CODE is not running\n", .{});
        std.process.exit(1);
    };
    defer _ = std.c.close(fd);
    var out_buf: [4096]u8 = undefined;
    const body = std.fmt.bufPrint(&out_buf, "{{\"chatId\":\"{s}\",\"url\":\"{s}\",\"headless\":{}}}\n", .{ std.mem.span(chat.?), target, headless }) catch {
        std.debug.print("address too long\n", .{});
        std.process.exit(2);
    };
    _ = std.c.write(fd, body.ptr, body.len);
    var resp: [256]u8 = undefined;
    const n = std.c.read(fd, &resp, resp.len);
    if (n <= 0) std.process.exit(1);
    const text = std.mem.trim(u8, resp[0..@intCast(n)], " \r\n");
    if (std.mem.eql(u8, text, "ok")) std.process.exit(0);
    std.debug.print("{s}\n", .{text});
    std.process.exit(1);
}
