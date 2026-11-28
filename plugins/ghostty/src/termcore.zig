//! Terminal core for the prototype: a child process on a PTY, its screen in libghostty-vt, and a flat
//! snapshot of the visible cells for the GTK side (main.c) to draw. No GTK here.

const std = @import("std");
const c = @cImport({
    @cInclude("pty.h");
    @cInclude("sys/ioctl.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
    @cInclude("string.h");
    @cInclude("errno.h");
    @cInclude("ghostty/vt.h");
});

/// One visible cell. flags: 1 bold, 2 italic, 4 underline, 8 inverse, 16 strikethrough, 32 faint.
/// wide: 0 narrow, 1 wide (drawn two columns), 2 spacer tail (the right half of a wide cell).
pub const TcCell = extern struct {
    cp: u32,
    fg: [3]u8,
    bg: [3]u8,
    flags: u8,
    wide: u8,
};

pub const TcFrame = extern struct {
    cols: u16,
    rows: u16,
    cells: [*]TcCell,
    fg: [3]u8,
    bg: [3]u8,
    cursor_visible: u8,
    cursor_x: u16,
    cursor_y: u16,
};

const allocator = std.heap.c_allocator;

var term: c.GhosttyTerminal = null;
var render: c.GhosttyRenderState = null;
var row_iter: c.GhosttyRenderStateRowIterator = null;
var row_cells: c.GhosttyRenderStateRowCells = null;
var master: c_int = -1;
var cols: u16 = 0;
var rows: u16 = 0;
var cell_buf: []TcCell = &.{};
var exited = false;

extern var environ: [*c][*c]u8;

fn fail(what: []const u8, result: c.GhosttyResult) void {
    std.debug.print("termcore: {s} failed ({d})\n", .{ what, result });
}

fn resetCellBuffer() void {
    if (cell_buf.len != 0) allocator.free(cell_buf);
    cell_buf = allocator.alloc(TcCell, @as(usize, cols) * rows) catch @panic("out of memory");
}

/// Drops every HERDR_* variable: inside a herdr pane they would make herdr refuse to start as a new instance.
fn unsetHerdrEnv() void {
    while (true) {
        var found: ?[]const u8 = null;
        var i: usize = 0;
        while (environ[i] != null) : (i += 1) {
            const entry = std.mem.span(environ[i]);
            if (std.mem.startsWith(u8, entry, "HERDR_")) {
                const eq = std.mem.indexOfScalar(u8, entry, '=') orelse entry.len;
                found = entry[0..eq];
                break;
            }
        }
        const name = found orelse return;
        var buf: [256]u8 = undefined;
        if (name.len >= buf.len) return;
        @memcpy(buf[0..name.len], name);
        buf[name.len] = 0;
        _ = c.unsetenv(&buf);
    }
}

/// Starts `argv` (NULL-terminated) on a new PTY of the given size. Returns 0 on success.
pub export fn tc_start(cols_in: u16, rows_in: u16, argv: [*c][*c]u8) c_int {
    cols = cols_in;
    rows = rows_in;
    if (c.ghostty_terminal_new(null, &term, cols, rows) != c.GHOSTTY_SUCCESS) return -1;
    // the default colors of Ghostty itself (its default theme), not libghostty's bare black on white
    const bg: c.GhosttyColorRgb = .{ .r = 0x28, .g = 0x2c, .b = 0x34 };
    const fg: c.GhosttyColorRgb = .{ .r = 0xff, .g = 0xff, .b = 0xff };
    _ = c.ghostty_terminal_set(term, c.GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &bg);
    _ = c.ghostty_terminal_set(term, c.GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &fg);
    _ = c.ghostty_render_state_new(null, &render);
    _ = c.ghostty_render_state_row_iterator_new(null, &row_iter);
    _ = c.ghostty_render_state_row_cells_new(null, &row_cells);
    resetCellBuffer();

    var ws: c.struct_winsize = .{ .ws_row = rows, .ws_col = cols, .ws_xpixel = 0, .ws_ypixel = 0 };
    const pid = c.forkpty(&master, null, null, &ws);
    if (pid < 0) return -1;
    if (pid == 0) {
        _ = c.setenv("TERM", "xterm-256color", 1);
        unsetHerdrEnv();
        // the program starts in the home folder, as the herdr panel did
        if (c.getenv("HOME")) |home| _ = c.chdir(home);
        _ = c.execvp(argv[0], argv);
        c._exit(127);
    }
    return 0;
}

/// The PTY's master side: the GTK main loop watches it for output.
pub export fn tc_fd() c_int {
    return master;
}

/// Reads what the child wrote and feeds it to the terminal. Returns 1 when data came, 0 when nothing,
/// -1 when the child has gone (its PTY closed).
pub export fn tc_pump() c_int {
    var buf: [65536]u8 = undefined;
    const n = c.read(master, &buf, buf.len);
    if (n > 0) {
        c.ghostty_terminal_vt_write(term, &buf, @intCast(n));
        return 1;
    }
    if (n == 0) {
        exited = true;
        return -1;
    }
    const err = std.c._errno().*;
    if (err == c.EAGAIN or err == c.EINTR) return 0;
    exited = true;
    return -1;
}

pub export fn tc_exited() c_int {
    return if (exited) 1 else 0;
}

/// Bytes typed by the user go to the child; typing returns the view to the bottom, as terminals do.
pub export fn tc_write(data: [*c]const u8, len: usize) void {
    if (master < 0 or len == 0) return;
    var off: usize = 0;
    while (off < len) {
        const n = c.write(master, data + off, len - off);
        if (n <= 0) return;
        off += @intCast(n);
    }
}

pub export fn tc_resize(cols_in: u16, rows_in: u16) void {
    if (cols_in == cols and rows_in == rows) return;
    cols = cols_in;
    rows = rows_in;
    _ = c.ghostty_terminal_resize(term, cols, rows, 0, 0);
    var ws: c.struct_winsize = .{ .ws_row = rows, .ws_col = cols, .ws_xpixel = 0, .ws_ypixel = 0 };
    _ = c.ioctl(master, c.TIOCSWINSZ, &ws);
    resetCellBuffer();
}

/// Moves the view through the scrollback by `delta` lines (negative is up).
pub export fn tc_scroll(delta: i32) void {
    const view: c.GhosttyTerminalScrollViewport = .{
        .tag = c.GHOSTTY_SCROLL_VIEWPORT_DELTA,
        .value = .{ .delta = delta },
    };
    c.ghostty_terminal_scroll_viewport(term, view);
}

/// True while the program has asked for mouse reports (then the wheel is sent to it, not to the scrollback).
pub export fn tc_mouse_tracking() c_int {
    var on: bool = false;
    _ = c.ghostty_terminal_get(term, c.GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &on);
    return if (on) 1 else 0;
}

fn rgbOf(color: c.GhosttyStyleColor, default: c.GhosttyColorRgb, palette: *const [256]c.GhosttyColorRgb) [3]u8 {
    return switch (color.tag) {
        c.GHOSTTY_STYLE_COLOR_PALETTE => blk: {
            const p = palette[color.value.palette];
            break :blk .{ p.r, p.g, p.b };
        },
        c.GHOSTTY_STYLE_COLOR_RGB => .{ color.value.rgb.r, color.value.rgb.g, color.value.rgb.b },
        else => .{ default.r, default.g, default.b },
    };
}

/// Fills `out` with the visible screen. The cell array stays valid until the next resize.
pub export fn tc_snapshot(out: *TcFrame) void {
    _ = c.ghostty_render_state_update(render, term);

    var colors: c.GhosttyRenderStateColors = std.mem.zeroes(c.GhosttyRenderStateColors);
    colors.size = @sizeOf(c.GhosttyRenderStateColors);
    _ = c.ghostty_render_state_get(render, c.GHOSTTY_RENDER_STATE_DATA_COLORS, &colors);

    var cursor: c.GhosttyRenderStateCursor = std.mem.zeroes(c.GhosttyRenderStateCursor);
    cursor.size = @sizeOf(c.GhosttyRenderStateCursor);
    _ = c.ghostty_render_state_get(render, c.GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);

    _ = c.ghostty_render_state_get(render, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&row_iter));
    const bg_default = colors.background;
    const fg_default = colors.foreground;

    var y: usize = 0;
    while (y < rows and c.ghostty_render_state_row_iterator_next(row_iter)) : (y += 1) {
        _ = c.ghostty_render_state_row_get(row_iter, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(&row_cells));
        var x: usize = 0;
        while (x < cols and c.ghostty_render_state_row_cells_next(row_cells)) : (x += 1) {
            var raw: c.GhosttyCell = 0;
            _ = c.ghostty_render_state_row_cells_get(row_cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
            var cp: u32 = 0;
            _ = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &cp);
            var wide: c.GhosttyCellWide = c.GHOSTTY_CELL_WIDE_NARROW;
            _ = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);

            var style: c.GhosttyStyle = std.mem.zeroes(c.GhosttyStyle);
            style.size = @sizeOf(c.GhosttyStyle);
            _ = c.ghostty_render_state_row_cells_get(row_cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);

            var flags: u8 = 0;
            if (style.bold) flags |= 1;
            if (style.italic) flags |= 2;
            if (style.underline != 0) flags |= 4;
            if (style.inverse) flags |= 8;
            if (style.strikethrough) flags |= 16;
            if (style.faint) flags |= 32;

            cell_buf[y * cols + x] = .{
                .cp = cp,
                .fg = rgbOf(style.fg_color, fg_default, &colors.palette),
                .bg = rgbOf(style.bg_color, bg_default, &colors.palette),
                .flags = flags,
                .wide = @intCast(wide),
            };
        }
        // rows the iterator did not reach stay as they were (only happens on a size mismatch)
    }

    out.cols = cols;
    out.rows = rows;
    out.cells = cell_buf.ptr;
    out.fg = .{ fg_default.r, fg_default.g, fg_default.b };
    out.bg = .{ bg_default.r, bg_default.g, bg_default.b };
    out.cursor_visible = if (cursor.visible and cursor.viewport_has_value) 1 else 0;
    out.cursor_x = cursor.viewport_x;
    out.cursor_y = cursor.viewport_y;
}
