# Terminal benchmark: ghostty-web panel vs the Ghostty app

Same 50 MB of output, same producer, measured two ways.

- **Case 1**: the herdr panel. Bun PTY → WebSocket (`plugins/herdr/web/server.ts`) → ghostty-web (WASM VT parser, canvas) in headless Chromium.
- **Case 3**: the Ghostty desktop app (`ghostty -e`), running the same command.

Run: `RUNS=3 PRODUCE=$PWD/produce-a.sh bun run.ts` (from a folder that has `page/vendor/` with the ghostty-web 0.4.0 `dist/` files, and `chrome-headless-shell` at the path in `run.ts`).

Workloads:
- **a**: 50 MB without newlines (`head -c 50000000 /dev/zero | tr '\0' a`).
- **b**: 50 MB of lines (`stty -onlcr; yes | head -c 50000000`).

Time is wall time to the end of the output. CPU is the summed utime+stime of the process tree. RSS is the peak sum over the tree.

## Results (median of 3, Linux, this machine)

| Workload | Case | Time | CPU | Peak RSS |
| --- | --- | --- | --- | --- |
| a | 1: panel (ghostty-web, headless Chromium) | 1140 ms | 1.53 s | 626 MB |
| a | 3: Ghostty app | 561 ms | 1.32 s | 180 MB |
| b | 1: panel (ghostty-web, headless Chromium) | 1876 ms | 2.27 s | 630 MB |
| b | 3: Ghostty app | 1525 ms | 2.89 s | 179 MB |

## Caveats

- Case 1 runs in headless Chromium, not in the app's WebKitGTK webview, so it is an approximation of the panel.
- Only 3 runs per case. Ghostty's timing is measured from a shell inside the window.
- The raw PTY alone, with newline translation, takes about 4.4 s for 75 MB here, and about 0.16 s for 50 MB without newlines. Both cases are above that floor.

## Bugs found while measuring (fixed in the wrapper)

- The wrapper closed the WebSocket on process exit, which could cut output still in the PTY. Closing now waits for the PTY exit callback.
- Bun drops WebSocket messages when `send` returns 0 (backpressure). The wrapper now queues refused messages and sends them on `drain`. Before this fix, 25–85% of the output was lost in some runs, so an earlier throughput figure of 16.6 MB/s was not valid.
