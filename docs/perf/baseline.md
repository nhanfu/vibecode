# Performance baseline (before the plugin-manager rewrite)

Measured on Linux (Wayland session, XWayland `DISPLAY=:0`), zero-native Linux build.

**Which build:** the binary `native/zig-out/bin/zn-probe` (built 09:13) and renderer `out/renderer` (built 09:16), taken from the tree before the agent code was removed. Git HEAD was `a2b2e9c` (Remove the built-in browser). The source on disk was not identical to HEAD (uncommitted herdr plugin files, and the chat/agent code still present when built), so treat this as the baseline of *that build*, not of a clean commit.

## Results

| Metric | Value | How |
| --- | --- | --- |
| Cold start: runtime init → first frame | **401 ms** | timestamps in `zero-native.jsonl` (`runtime.init` → first `frame published`) |
| Cold start: launch → first frame (wall, incl. shell) | 566 ms | `date +%s%N` around the launch |
| Renderer JS | 99 files, **14.99 MB** raw, **3.64 MB** gzip (sum of each file gzipped) | `out/renderer/assets/*.js` |
| Largest JS chunks (raw / gzip) | `ts.worker` 6.93 MB / 1.49 MB; `editor.api` 2.74 MB / 0.70 MB; `monaco` 1.32 MB / 0.33 MB; `css.worker` 1.08 MB / 0.25 MB; `boot` 0.96 MB / 0.28 MB | same |
| CSS | 299 KB | same |
| Idle RSS, app process (0 chats) | **1,099,312 KB at 60 s**, **1,099,040 KB at 90 s** (~1.05 GB) | `ps -o rss=` |
| Idle RSS, ptyd process | 20,500 KB | `ps -o rss=` |
| Idle bridge requests | **0** in 30 s | `bridge request handled` lines in the log |
| Idle frames published | **0** in 30 s | `frame published` lines in the log |

## Not measured yet

- **RSS with 3 chats**: needs the UI to create chats. The chat code is being removed, so this is not repeatable on the new code anyway.
- **Terminal throughput** (`yes | head -c 50M`): needs a terminal in the UI; not run.
- **WebKit web-process memory**: `ps` on the app process reports only the main process. The WebKit renderer processes are separate and not included in the 1.05 GB figure, so total memory is higher.

## Observations

- Idle RSS of the app process is about **1 GB with no activity**. Earlier single `ps` readings of the same process were 402 MB and 252 MB, taken at different moments and without a fixed wait, so they are not comparable and are left out of the table. The growth over time is not established yet; step 1 only has the 60 s and 90 s readings above.
- Idle activity is zero (no bridge calls, no frames): the idle cost is memory, not CPU work.
- The renderer ships ~15 MB of JavaScript, most of it Monaco language workers. Those are loaded eagerly in the current build.

## Note on the files

The `zig build` run for the agent-removal step rebuilt `native/zig-out/bin/zn-probe`, so the binary measured above no longer exists on disk. The numbers in this file were recorded before that rebuild and are not affected by it.
