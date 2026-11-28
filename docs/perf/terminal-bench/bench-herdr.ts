// Benchmark of the herdr panel page: 50 MB through the wrapper into xterm, timed until the program's output
// is all shown. RENDERER=gl (WebGL addon) or dom (xterm default). Prints one JSON line.
const RENDERER = process.env.RENDERER ?? 'gl'
const PRODUCE = process.env.PRODUCE ?? '/home/nhanjs/projects/vibecode-zero-native/docs/perf/terminal-bench/produce-a.sh'
const RUNS = Number(process.env.RUNS ?? 3)
const PORT = 18951, TOKEN = 'benchtok', CDP = 9351
const CLK = 100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ticks = (pid: number) => { try { const s = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return Number(f[11]) + Number(f[12]) } catch { return 0 } }
const rss = (pid: number) => { try { const m = require('node:fs').readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/); return m ? Number(m[1]) : 0 } catch { return 0 } }
function treeOf(root: number): number[] {
  const fs = require('node:fs'); const parent = new Map<number, number>()
  for (const name of fs.readdirSync('/proc')) { if (!/^\d+$/.test(name)) continue
    try { const s = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); parent.set(Number(name), Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1])) } catch {} }
  const out = [root]; for (let i = 0; i < out.length; i++) for (const [p, pp] of parent) if (pp === out[i] && !out.includes(p)) out.push(p)
  return out
}
const wrapper = Bun.spawn(['bun', '/home/nhanjs/projects/vibecode-zero-native/plugins/herdr/web/server.ts'], {
  env: { ...process.env, HERDR_WEB_PORT: String(PORT), HERDR_WEB_TOKEN: TOKEN, HERDR_WEB_COMMAND: PRODUCE }, stdout: 'ignore', stderr: 'ignore' })
await sleep(800)
const profile = `${process.env.JOB}/tmp/bench-prof-${RENDERER}`
require('node:fs').rmSync(profile, { recursive: true, force: true })
const chrome = Bun.spawn(['/home/nhanjs/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
  '--no-sandbox', ...(process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean), `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
await sleep(1500)
const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as any[]
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let nid = 1; const pend = new Map<number, (v: any) => void>()
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id) } }
const send = (method: string, params: any = {}) => new Promise<any>((r) => { const id = nid++; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Page.enable')
const DONE = `(() => { const b = term.buffer.active; for (let i = b.length - 1; i >= Math.max(0, b.length - 6); i--) if (b.getLine(i)?.translateToString(true).includes('herdr closed')) return true; return false })()`
const results: any[] = []
for (let i = 0; i < RUNS; i++) {
  const pids = () => [...treeOf(chrome.pid), ...treeOf(wrapper.pid)]
  const start = new Map<number, number>(); for (const p of pids()) start.set(p, ticks(p))
  let peak = 0, stop = false
  const sampler = (async () => { while (!stop) { let s = 0; for (const p of pids()) s += rss(p); if (s > peak) peak = s; await sleep(200) } })()
  const t0 = Date.now()
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?renderer=${RENDERER === 'dom' ? 'dom' : 'gl'}&run=${i}` })
  let done = false
  while (!done && Date.now() - t0 < 120000) { await sleep(50); const r = await send('Runtime.evaluate', { expression: `typeof term !== 'undefined' && ${DONE}`, returnByValue: true }); done = !!r.result?.result?.value }
  const ms = Date.now() - t0
  const info = await send('Runtime.evaluate', { expression: `JSON.stringify({ canvases: document.querySelectorAll('canvas').length, webgl: (() => { try { const c = document.createElement('canvas'); return !!c.getContext('webgl2') } catch { return false } })() })`, returnByValue: true })
  stop = true; await sampler
  let cpu = 0; for (const p of pids()) cpu += ticks(p) - (start.get(p) ?? ticks(p))
  results.push({ ms, cpuSec: +(cpu / CLK).toFixed(2), peakRssMB: Math.round(peak / 1024), info: info.result?.result?.value, done })
  await sleep(500)
}
const med = (k: string) => [...results.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(results.length / 2)]
console.log(JSON.stringify({ renderer: RENDERER, produce: PRODUCE.split('/').pop(), ms_median: med('ms'), cpuSec_median: med('cpuSec'), peakRssMB_median: med('peakRssMB'), runs: results }, null, 1))
ws.close(); chrome.kill(); wrapper.kill()
