const std = @import("std");

const easylist = @embedFile("easylist.json");
const filter_id = "vibecode-easylist-1";

const GError = extern struct {
    domain: u32,
    code: c_int,
    message: [*:0]const u8,
};

const SaveCallback = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;

extern "c" fn write(fd: c_int, buf: [*]const u8, count: usize) isize;
extern "c" fn mkdir(path: [*:0]const u8, mode: c_uint) c_int;
extern "c" fn g_bytes_new_static(data: *const anyopaque, size: usize) ?*anyopaque;
extern "c" fn g_error_free(err: *GError) void;
extern "c" fn webkit_user_content_filter_store_new(path: [*:0]const u8) ?*anyopaque;
extern "c" fn webkit_user_content_filter_store_save(store: *anyopaque, identifier: [*:0]const u8, source: *anyopaque, cancellable: ?*anyopaque, callback: SaveCallback, user_data: ?*anyopaque) void;
extern "c" fn webkit_user_content_filter_store_save_finish(store: *anyopaque, result: ?*anyopaque, error_out: *?*GError) ?*anyopaque;
extern "c" fn webkit_web_view_get_user_content_manager(view: *anyopaque) ?*anyopaque;
extern "c" fn webkit_user_content_manager_add_filter(manager: *anyopaque, filter: *anyopaque) void;

var compiled: ?*anyopaque = null;

fn saved(store: ?*anyopaque, result: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {
    var err: ?*GError = null;
    const filter = webkit_user_content_filter_store_save_finish(store.?, result, &err);
    if (filter) |f| {
        compiled = f;
        return;
    }
    if (err) |e| {
        var buf: [1024]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "ad filter not compiled: {s}\n", .{std.mem.span(e.message)}) catch "ad filter not compiled\n";
        _ = write(2, line.ptr, line.len);
        g_error_free(e);
    }
}

pub export fn vc_adblock_start(data_dir: [*:0]const u8) void {
    var buf: [4096]u8 = undefined;
    const dir = std.fmt.bufPrintZ(&buf, "{s}/adblock", .{std.mem.span(data_dir)}) catch return;
    _ = mkdir(dir.ptr, 0o755);
    const store = webkit_user_content_filter_store_new(dir.ptr) orelse return;
    const source = g_bytes_new_static(easylist.ptr, easylist.len) orelse return;
    webkit_user_content_filter_store_save(store, filter_id, source, null, saved, null);
}

pub export fn vc_adblock_ready() bool {
    return compiled != null;
}

pub export fn vc_adblock_attach(view: *anyopaque) void {
    const filter = compiled orelse return;
    const manager = webkit_web_view_get_user_content_manager(view) orelse return;
    webkit_user_content_manager_add_filter(manager, filter);
}
