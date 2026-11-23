//! Web tabs: each is a native page laid over the spot the Web drop-down reserves for it, on the main window.
//! Port of the part of src-tauri/src/browser.rs the page drives: open, place, navigate, history, reload,
//! stop, focus, user agent, close, and the navigation state reported back (`web:nav`).
//!
//! The pages live in the GTK host of the vendored zero-native (native/vendor/zero-native, patched for this):
//! only labels starting `web-` are browser pages, and those may load http and https pages.
//! Not yet: Claude's browser tools (DevTools: evaluate, screenshot, console), dark mode, suspending hidden tabs.

const std = @import("std");
const zn = @import("zero-native");
const cmd = @import("root.zig");

extern "c" fn zero_native_gtk_web_history(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize, step: c_int) c_int;
extern "c" fn zero_native_gtk_web_reload(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize, hard: c_int) c_int;
extern "c" fn zero_native_gtk_web_stop(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize) c_int;
extern "c" fn zero_native_gtk_web_visible(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize, visible: c_int) c_int;
extern "c" fn zero_native_gtk_web_mute(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize, muted: c_int) c_int;
extern "c" fn zero_native_gtk_web_focus(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize) c_int;
extern "c" fn zero_native_gtk_web_set_dark_library(host: *anyopaque, source: [*]const u8, len: usize) c_int;
extern "c" fn zero_native_gtk_web_set_dark(host: *anyopaque, window_id: u64, dark: c_int) c_int;
extern "c" fn zero_native_gtk_web_user_agent(host: *anyopaque, window_id: u64, label: [*]const u8, label_len: usize, agent: [*]const u8, agent_len: usize) c_int;

const main_window: zn.platform.WindowId = 1;

const Nav = struct {
    url: []u8,
    title: []u8,
    back: bool,
    fwd: bool,
    loading: bool,
};

const Tab = struct {
    key: []u8,
    chat: []u8,
};

var tabs: std.StringHashMapUnmanaged(Tab) = .empty;
var navs: std.StringHashMapUnmanaged(Nav) = .empty;
var active: std.StringHashMapUnmanaged([]u8) = .empty;
const dark_library = @embedFile("../assets/darkreader.js");
var library_sent = false;

fn host() !*anyopaque {
    return zn.platform.gtk_host.web_host orelse error.NoWindow;
}

fn services() !zn.platform.PlatformServices {
    const rt = cmd.runtime orelse return error.NoWindow;
    return rt.options.platform.services;
}

fn allowedUrl(url: []const u8) bool {
    return std.mem.startsWith(u8, url, "https://") or std.mem.startsWith(u8, url, "http://") or std.mem.startsWith(u8, url, "about:");
}

fn tabKnown(label: []const u8) bool {
    return tabs.contains(label);
}

const OpenArgs = struct { label: []const u8, chatId: []const u8, url: []const u8, userAgent: ?[]const u8 = null };

pub fn open(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(OpenArgs, a, invocation);
    if (tabKnown(args.label)) return cmd.json(output, null);
    if (!allowedUrl(args.url)) return cmd.fail(output, "this address cannot be opened");

    const h0 = try host();
    if (!library_sent) {
        _ = zero_native_gtk_web_set_dark_library(h0, dark_library.ptr, dark_library.len);
        library_sent = true;
    }
    const svc = try services();
    try svc.createWebView(.{ .window_id = main_window, .label = args.label, .url = args.url, .frame = zn.geometry.RectF.init(0, 0, 1, 1) });
    const h = try host();
    _ = zero_native_gtk_web_visible(h, main_window, args.label.ptr, args.label.len, 0);

    const key = try cmd.gpa.dupe(u8, args.label);
    errdefer cmd.gpa.free(key);
    const chat = try cmd.gpa.dupe(u8, args.chatId);
    errdefer cmd.gpa.free(chat);
    try tabs.put(cmd.gpa, key, .{ .key = key, .chat = chat });
    if (args.userAgent) |agent| _ = zero_native_gtk_web_user_agent(h, main_window, args.label.ptr, args.label.len, agent.ptr, agent.len);
    return cmd.json(output, null);
}

const PlaceArgs = struct { label: []const u8, x: f64, y: f64, w: f64, h: f64, zoom: f64, visible: bool };

pub fn place(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(PlaceArgs, arena.allocator(), invocation);
    if (!tabKnown(args.label)) return cmd.json(output, null);
    const h = try host();
    const svc = try services();
    if (args.w > 0 and args.h > 0) {
        svc.setWebViewFrame(main_window, args.label, zn.geometry.RectF.init(@floatCast(args.x), @floatCast(args.y), @floatCast(args.w), @floatCast(args.h))) catch {};
    }
    _ = zero_native_gtk_web_visible(h, main_window, args.label.ptr, args.label.len, if (args.visible) 1 else 0);
    if (args.zoom >= 0.25 and args.zoom <= 5.0) svc.setWebViewZoom(main_window, args.label, args.zoom) catch {};
    return cmd.json(output, null);
}

pub fn setActive(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { chatId: []const u8, label: []const u8 }, arena.allocator(), invocation);
    if (active.fetchRemove(args.chatId)) |old| {
        cmd.gpa.free(old.key);
        cmd.gpa.free(old.value);
    }
    const key = try cmd.gpa.dupe(u8, args.chatId);
    errdefer cmd.gpa.free(key);
    try active.put(cmd.gpa, key, try cmd.gpa.dupe(u8, args.label));
    return cmd.json(output, null);
}

pub fn focus(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8 }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_focus(try host(), main_window, args.label.ptr, args.label.len);
    return cmd.json(output, null);
}

pub fn navigate(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8, url: []const u8 }, arena.allocator(), invocation);
    if (!tabKnown(args.label)) return cmd.fail(output, "the tab is closed");
    if (!allowedUrl(args.url)) return cmd.fail(output, "this address cannot be opened");
    try (try services()).navigateWebView(main_window, args.label, args.url);
    return cmd.json(output, null);
}

pub fn history(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8, step: i32 }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_history(try host(), main_window, args.label.ptr, args.label.len, args.step);
    return cmd.json(output, null);
}

pub fn reload(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8, hard: bool = false }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_reload(try host(), main_window, args.label.ptr, args.label.len, if (args.hard) 1 else 0);
    return cmd.json(output, null);
}

pub fn stop(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8 }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_stop(try host(), main_window, args.label.ptr, args.label.len);
    return cmd.json(output, null);
}

pub fn setUserAgent(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8, userAgent: ?[]const u8 = null }, arena.allocator(), invocation);
    const agent = args.userAgent orelse "";
    _ = zero_native_gtk_web_user_agent(try host(), main_window, args.label.ptr, args.label.len, agent.ptr, agent.len);
    return cmd.json(output, null);
}

pub fn setDark(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { dark: bool }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_set_dark(try host(), main_window, if (args.dark) 1 else 0);
    return cmd.json(output, null);
}

pub fn navState(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8 }, arena.allocator(), invocation);
    const nav = navs.get(args.label) orelse return cmd.json(output, null);
    return cmd.json(output, .{ .url = nav.url, .title = nav.title, .back = nav.back, .fwd = nav.fwd, .loading = nav.loading });
}

pub fn close(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8 }, arena.allocator(), invocation);
    if (tabs.fetchRemove(args.label)) |entry| {
        cmd.gpa.free(entry.value.key);
        cmd.gpa.free(entry.value.chat);
        (try services()).closeWebView(main_window, args.label) catch {};
    }
    if (navs.fetchRemove(args.label)) |entry| {
        cmd.gpa.free(entry.key);
        cmd.gpa.free(entry.value.url);
        cmd.gpa.free(entry.value.title);
    }
    return cmd.json(output, null);
}

export fn zero_native_web_nav(window_id: u64, label: [*:0]const u8, url: [*:0]const u8, title: [*:0]const u8, loading: c_int, can_back: c_int, can_forward: c_int) callconv(.c) void {
    _ = window_id;
    const label_text = std.mem.span(label);
    const url_text = std.mem.span(url);
    const title_text = std.mem.span(title);
    const nav = Nav{
        .url = cmd.gpa.dupe(u8, url_text) catch return,
        .title = cmd.gpa.dupe(u8, title_text) catch return,
        .back = can_back != 0,
        .fwd = can_forward != 0,
        .loading = loading != 0,
    };
    if (navs.fetchRemove(label_text)) |old| {
        cmd.gpa.free(old.key);
        cmd.gpa.free(old.value.url);
        cmd.gpa.free(old.value.title);
    }
    const key = cmd.gpa.dupe(u8, label_text) catch return;
    navs.put(cmd.gpa, key, nav) catch return;

    var a = std.heap.ArenaAllocator.init(cmd.gpa);
    defer a.deinit();
    const json = std.json.Stringify.valueAlloc(a.allocator(), .{ label_text, .{ .url = nav.url, .title = nav.title, .back = nav.back, .fwd = nav.fwd, .loading = nav.loading } }, .{}) catch return;
    cmd.emit("web:nav", json);
}

pub fn setMuted(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const args = try cmd.args(struct { label: []const u8, muted: bool }, arena.allocator(), invocation);
    _ = zero_native_gtk_web_mute(try host(), main_window, args.label.ptr, args.label.len, if (args.muted) 1 else 0);
    return cmd.json(output, null);
}
