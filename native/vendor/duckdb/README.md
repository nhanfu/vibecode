# DuckDB sources

`duckdb-1.10506.1.tar.gz` is the DuckDB source archive bundled by the `libduckdb-sys` crate 1.10506.1
(the version `src-tauri` pins with `duckdb = "=1.10506.1"`), so the app keeps the same database format.

`sources.txt` lists what the Tauri build compiled: the base sources and the `core_functions` extension
(`F` lines are C++ files relative to the archive root, `I` lines are include directories relative to `duckdb/`).
`build.zig` extracts the archive and compiles these with the same defines the crate uses.
