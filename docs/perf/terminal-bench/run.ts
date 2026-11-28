// Benchmark: the same 50 MB of output, shown by (1) ghostty-web in a headless Chromium panel behind the
// herdr wrapper, and (2) Ghostty (the desktop app) running the same command. Prints one JSON line.
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'

const B = import.meta.dir
const RUNS = Number(process.env.RUNS ?? 3)
const PRODUCE = process.env.PRODUCE ?? `${import.meta.dir}/produce-a.sh`
const CLK = 100 // clock ticks per second
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function ticks(pid: number): number {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return Number(f[11]) + Number(f[12]) // utime + stime
  } catch {
    return 0
  }
}
function rssKB(pid: number): number {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}
// every process under `root` (its children, their children…): Chrome's zygote, renderer and GPU
// processes do not carry the profile flag, so they are found through the process tree instead
function treeOf(root: number): number[] {
  const parent = new Map<number, number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const s = readFileSync(`/proc/${name}/stat`, 'utf8')
      parent.set(Number(name), Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]))
    } catch { /* gone */ }
  }
  const out = [root]
  for (let i = 0; i < out.length; i++) for (const [pid, ppid] of parent) if (ppid === out[i] && !out.includes(pid)) out.push(pid)
  return out
}

// sample RSS (peak of the sum) and CPU seconds (delta) for a set of pids while `work` runs
async function measure(pidsOf: () => Promise<number[]>, work: () => Promise<void>) {
  const start = new Map<number, number>()
  for (const p of await pidsOf()) start.set(p, ticks(p))
  let peak = 0
  let stop = false
  const sampler = (async () => {
    while (!stop) {
      const ps = await pidsOf()
      let sum = 0
      for (const p of ps) sum += rssKB(p)
      if (sum > peak) peak = sum
      await sleep(200)
    }
  })()
  await work()
  stop = true
  await sampler
  let cpu = 0
  for (const p of await pidsOf()) cpu += ticks(p) - (start.get(p) ?? ticks(p))
  return { cpuSec: +(cpu / CLK).toFixed(2), peakRssMB: Math.round(peak / 1024) }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// ---- static server for the page
const page = Bun.serve({ hostname: '127.0.0.1', port: 18900, async fetch(req) {
  const u = new URL(req.url)
  const name = u.pathname === '/' ? '/index.html' : u.pathname
  const f = Bun.file(`${B}/page${name}`)
  return (await f.exists()) ? new Response(f) : new Response('nf', { status: 404 })
} })

// ---- case 1: herdr wrapper + ghostty-web in headless Chromium
const PORT = 18901, TOKEN = 'benchtok'
const wrapper = Bun.spawn(['/home/nhanjs/projects/vibecode-zero-native/plugins/herdr/launch.sh'], {
  env: { ...process.env, HERDR_WEB_PORT: String(PORT), HERDR_WEB_TOKEN: TOKEN, HERDR_WEB_COMMAND: PRODUCE },
  stdout: 'ignore', stderr: 'ignore'
})
const profile = '/tmp/bench-chrome-profile'
rmSync(profile, { recursive: true, force: true })
const chrome = Bun.spawn(['/home/nhanjs/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
  '--no-sandbox', '--disable-gpu-compositing', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' })
await sleep(1500)
const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json() as { type: string; webSocketDebuggerUrl: string }[]
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let nextId = 1
const pending = new Map<number, (v: any) => void>()
const waiters: ((m: any) => void)[] = []
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
  for (const w of waiters) w(m)
}
const send = (method: string, params: any = {}) => new Promise<any>((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Page.enable')

async function runCase1(): Promise<{ ms: number; bytes: number; msgs: number }> {
  await new Promise<void>((resolve) => {
    const w = (m: any) => { if (m.method === 'Page.loadEventFired') { waiters.splice(waiters.indexOf(w), 1); resolve() } }
    waiters.push(w)
    send('Page.navigate', { url: 'http://127.0.0.1:18900/' })
  })
  const url = `ws://127.0.0.1:${PORT}/pty?token=${TOKEN}&folder=/tmp`
  let result: any
  const pids = async () => [...treeOf(chrome.pid), ...treeOf(wrapper.pid)]
  const m = await measure(pids, async () => {
    const r = await send('Runtime.evaluate', { expression: `window.runBench(${JSON.stringify(url)})`, awaitPromise: true, returnByValue: true })
    result = r.result?.result?.value ?? r
  })
  return { ...result, ...m }
}

// ---- case 3: the Ghostty desktop app, running the same command in its own window
async function runCase3(): Promise<{ ms: number; cpuSec: number; peakRssMB: number }> {
  const result = '/tmp/bench-ghostty-result.txt'
  rmSync(result, { force: true })
  const g = Bun.spawn(['ghostty', '--gtk-single-instance=false', '--title=bench-ghostty', '-e', '/bin/sh', '-c',
    `S=$(date +%s%N); ${PRODUCE}; E=$(date +%s%N); echo $(( (E-S)/1000000 )) > ${result}; sleep 120`],
    { stdout: 'ignore', stderr: 'ignore' })
  const m = await measure(async () => treeOf(g.pid), async () => {
    const t = Date.now()
    while (!existsSync(result) && Date.now() - t < 120000) await sleep(50)
  })
  const ms = Number(readFileSync(result, 'utf8').trim())
  g.kill()
  await sleep(500)
  return { ms, ...m }
}

const case1: any[] = []
for (let i = 0; i < RUNS; i++) case1.push(await runCase1())
const case3: any[] = []
for (let i = 0; i < RUNS; i++) case3.push(await runCase3())

const summary = (rs: any[]) => ({ ms_median: median(rs.map((r) => r.ms)), ms_all: rs.map((r) => Math.round(r.ms)), cpuSec_median: median(rs.map((r) => r.cpuSec)), peakRssMB_median: median(rs.map((r) => r.peakRssMB)) })
console.log(JSON.stringify({ case1_ghostty_web_panel_headless_chromium: summary(case1), case3_ghostty_desktop_app: summary(case3), bytes: 50000000, raw1: case1, raw3: case3 }, null, 1))

ws.close(); chrome.kill(); wrapper.kill(); page.stop(true)
