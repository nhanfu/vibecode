//! Native plugins: a plugin's library (plugin.json "native") is loaded into the app's process once, and the app
//! calls its functions as the ABI says (plugins/ghostty/src/vibe_plugin.h). The app gives it its table of host
//! functions: the window's overlay and running script in the page.

const std = @import("std");
const cmd = @import("root.zig");
const plugins = @import("plugins.zig");

extern fn zero_native_gtk_app_overlay() ?*anyopaque;
extern fn zero_native_gtk_app_eval(script: [*c]const u8) void;

const Host = extern struct {
    abi: c_int,
    app_overlay: *const fn () callconv(.c) ?*anyopaque,
    app_eval: *const fn ([*c]const u8) callconv(.c) void,
};

const InitFn = *const fn (*const Host) callconv(.c) c_int;
const OpenFn = *const fn ([*c][*c]u8) callconv(.c) c_int;
const FrameFn = *const fn (f64, f64, f64, f64, c_int) callconv(.c) void;

const abi_version: c_int = 1;

fn overlayForPlugin() callconv(.c) ?*anyopaque {
    return zero_native_gtk_app_overlay();
}

fn evalForPlugin(script: [*c]const u8) callconv(.c) void {
    zero_native_gtk_app_eval(script);
}

const Loaded = struct {
    lib: std.DynLib,
    open: OpenFn,
    frame: FrameFn,
};

var host_table: Host = undefined;

/// Loaded plugin libraries by id. A library stays loaded until the app exits.
var loaded: std.StringHashMapUnmanaged(Loaded) = .empty;

/// Loads the plugin's library on first use and runs its init with the host table.
fn load(a: std.mem.Allocator, id: []const u8) !*Loaded {
    if (loaded.getPtr(id)) |entry| return entry;
    const path = (try plugins.nativeLibrary(a, id)) orelse return error.NotNative;
    const path_z = try a.dupeZ(u8, path);
    var lib = try std.DynLib.open(path_z);
    errdefer lib.close();
    const init = lib.lookup(InitFn, "vibe_plugin_init") orelse return error.MissingSymbol;
    const open_fn = lib.lookup(OpenFn, "vibe_panel_open") orelse return error.MissingSymbol;
    const frame_fn = lib.lookup(FrameFn, "vibe_panel_frame") orelse return error.MissingSymbol;
    // the plugin keeps the pointer: the table lives as long as the app
    host_table = .{ .abi = abi_version, .app_overlay = &overlayForPlugin, .app_eval = &evalForPlugin };
    if (init(&host_table) != 0) return error.InitFailed;
    const key = try cmd.gpa.dupe(u8, id);
    try loaded.put(cmd.gpa, key, .{ .lib = lib, .open = open_fn, .frame = frame_fn });
    return loaded.getPtr(key).?;
}

/// `{ id, command }`: creates the plugin's panel and starts `command` in it (empty: the user's shell).
pub fn open(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, command: []const []const u8 }, a, invocation);
    const lib = load(a, args.id) catch |err| return cmd.fail(output, @errorName(err));

    const argv = try a.alloc([*c]u8, args.command.len + 1);
    for (args.command, 0..) |part, i| argv[i] = (try a.dupeZ(u8, part)).ptr;
    argv[args.command.len] = null;
    if (lib.open(argv.ptr) != 0) return cmd.fail(output, "the panel could not be created");
    return cmd.json(output, true);
}

/// `{ id, x, y, width, height, visible }`: where the plugin's panel sits in the window (CSS pixels).
pub fn frame(invocation: cmd.Invocation, output: []u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(cmd.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try cmd.args(struct { id: []const u8, x: f64, y: f64, width: f64, height: f64, visible: bool }, a, invocation);
    const lib = loaded.getPtr(args.id) orelse return cmd.fail(output, "the panel is not open");
    lib.frame(args.x, args.y, args.width, args.height, @intFromBool(args.visible));
    return cmd.json(output, null);
}
