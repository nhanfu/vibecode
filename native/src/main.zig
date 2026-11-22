const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const commands = @import("commands/root.zig");
const registry = @import("commands/registry.zig");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "vibe-code",
            .source = zero_native.frontend.productionSource(.{ .dist = "../out/renderer" }),
            .source_fn = source,
            .start_fn = start,
        };
    }

    fn start(_: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        commands.runtime = runtime;
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return zero_native.frontend.sourceFromEnv(self.env_map, .{
            .dist = "../out/renderer",
            .entry = "index.html",
        });
    }
};

/// The built-in open dialog is the only desktop API the page may call (the folder and file pickers).
const builtin_commands = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "zero-native.dialog.openFile", .origins = &commands.origins },
};

pub fn main(init: std.process.Init) !void {
    commands.io = init.io;
    commands.gpa = init.gpa;
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "VIBE CODE",
        .window_title = "VIBE CODE",
        .bundle_id = "vn.tinjs.vibecode",
        .icon_path = "assets/icon.icns",
        .security = .{
            .navigation = .{ .allowed_origins = &commands.origins },
        },
        .builtin_bridge = .{ .enabled = true, .commands = &builtin_commands },
        .bridge = .{
            .policy = .{ .enabled = true, .commands = registry.policy },
            .registry = .{ .handlers = &registry.handlers },
        },
    }, init);
}

test "every registered command has a policy entry" {
    try std.testing.expectEqual(registry.names.len, registry.handlers.len);
    try std.testing.expectEqual(registry.names.len, registry.policy.len);
}
