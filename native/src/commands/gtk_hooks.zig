//! Two callbacks the vendored GTK host (native/vendor/zero-native, linux/gtk_host.c) calls into the app. They
//! reported the state of the built-in browser's pages, which the app no longer has, so they do nothing. The
//! host still calls them from its load handlers (only for child pages, never for the app's own window), so the
//! symbols must exist for the Linux build to link. Remove them together with the browser code in the vendored host.

/// Navigation state of a child page: called by the host on each load change.
export fn zero_native_web_nav(window_id: u64, label: [*:0]const u8, url: [*:0]const u8, title: [*:0]const u8, loading: c_int, can_back: c_int, can_forward: c_int) callconv(.c) void {
    _ = window_id;
    _ = label;
    _ = url;
    _ = title;
    _ = loading;
    _ = can_back;
    _ = can_forward;
}

/// A child page's saved history: called by the host when its load finishes.
export fn zero_native_web_session(window_id: u64, label: [*:0]const u8, data: [*:0]const u8) callconv(.c) void {
    _ = window_id;
    _ = label;
    _ = data;
}
