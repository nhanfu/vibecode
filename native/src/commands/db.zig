//! A small wrapper over the DuckDB C API: one connection, plain SQL, and prepared statements with
//! typed parameters. Used by userdb.zig (and anything else that keeps data in the user's database).
//! Calls run on the bridge's thread, one at a time, so no locking is needed.

const std = @import("std");
const c = @import("duckdb_c");

pub const Error = error{ DbOpenFailed, DbQueryFailed, DbBindFailed };

pub const Param = union(enum) {
    text: []const u8,
    int: i32,
    boolean: bool,
    null_value,
};

var database: c.duckdb_database = null;
var connection: c.duckdb_connection = null;
var last_error_buffer: [1024]u8 = undefined;
var last_error: []const u8 = "";

pub fn lastError() []const u8 {
    return last_error;
}

fn remember(message: [*c]const u8) void {
    const text = if (message == null) "unknown database error" else std.mem.span(message);
    const n = @min(text.len, last_error_buffer.len);
    @memcpy(last_error_buffer[0..n], text[0..n]);
    last_error = last_error_buffer[0..n];
}

pub fn open(path: [:0]const u8) Error!void {
    if (connection != null) return;
    if (c.duckdb_open(path.ptr, &database) != c.DuckDBSuccess) {
        remember("could not open the database file");
        return Error.DbOpenFailed;
    }
    if (c.duckdb_connect(database, &connection) != c.DuckDBSuccess) {
        remember("could not connect to the database");
        return Error.DbOpenFailed;
    }
}

/// Runs one or more statements with no parameters, and discards any rows.
pub fn exec(sql: [:0]const u8) Error!void {
    var result: c.duckdb_result = undefined;
    defer c.duckdb_destroy_result(&result);
    if (c.duckdb_query(connection, sql.ptr, &result) != c.DuckDBSuccess) {
        remember(c.duckdb_result_error(&result));
        return Error.DbQueryFailed;
    }
}

/// Prepares `sql`, binds `params` in order (1-based in SQL), runs it and returns its rows.
/// Strings and rows are owned by `result`; call `Rows.deinit` when done.
pub const Rows = struct {
    result: c.duckdb_result,

    pub fn deinit(self: *Rows) void {
        c.duckdb_destroy_result(&self.result);
    }

    pub fn count(self: *Rows) usize {
        return @intCast(c.duckdb_row_count(&self.result));
    }

    /// Text in column `col` of row `row`, copied into `a`; null when the value is NULL.
    pub fn text(self: *Rows, a: std.mem.Allocator, col: usize, row: usize) !?[]const u8 {
        if (c.duckdb_value_is_null(&self.result, col, row)) return null;
        const raw = c.duckdb_value_varchar(&self.result, col, row);
        defer c.duckdb_free(raw);
        return try a.dupe(u8, std.mem.span(raw));
    }

    pub fn boolean(self: *Rows, col: usize, row: usize) bool {
        return c.duckdb_value_boolean(&self.result, col, row);
    }

    pub fn int32(self: *Rows, col: usize, row: usize) i32 {
        return c.duckdb_value_int32(&self.result, col, row);
    }
};

pub fn query(sql: [:0]const u8, params: []const Param) Error!Rows {
    var stmt: c.duckdb_prepared_statement = null;
    defer c.duckdb_destroy_prepare(&stmt);
    if (c.duckdb_prepare(connection, sql.ptr, &stmt) != c.DuckDBSuccess) {
        remember(c.duckdb_prepare_error(stmt));
        return Error.DbQueryFailed;
    }
    for (params, 0..) |param, i| {
        const idx: c.idx_t = @intCast(i + 1);
        const state = switch (param) {
            .text => |t| c.duckdb_bind_varchar_length(stmt, idx, t.ptr, @intCast(t.len)),
            .int => |v| c.duckdb_bind_int32(stmt, idx, v),
            .boolean => |v| c.duckdb_bind_boolean(stmt, idx, v),
            .null_value => c.duckdb_bind_null(stmt, idx),
        };
        if (state != c.DuckDBSuccess) {
            remember("could not bind a parameter");
            return Error.DbBindFailed;
        }
    }
    var result: c.duckdb_result = undefined;
    if (c.duckdb_execute_prepared(stmt, &result) != c.DuckDBSuccess) {
        remember(c.duckdb_result_error(&result));
        c.duckdb_destroy_result(&result);
        return Error.DbQueryFailed;
    }
    return .{ .result = result };
}

/// Like `query`, for statements whose rows are not needed.
pub fn run(sql: [:0]const u8, params: []const Param) Error!void {
    var rows = try query(sql, params);
    rows.deinit();
}

pub fn begin() Error!void {
    try exec("BEGIN");
}

pub fn commit() Error!void {
    try exec("COMMIT");
}

pub fn rollback() void {
    exec("ROLLBACK") catch {};
}

/// Folds the write-ahead log into the file so a copy of it is complete.
pub fn checkpoint() void {
    exec("CHECKPOINT") catch {};
}
