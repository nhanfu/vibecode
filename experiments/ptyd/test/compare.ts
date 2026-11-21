import { Client } from './client'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const [label, settleMs, ...program] = process.argv.slice(2)
const dir = mkdtempSync(join(tmpdir(), 'ptyd-'))
const sock = join(dir, 's.sock')
const [cols, rows] = [110, 32]

// the daemon lives in a session of its own: it must not depend on this script
const daemon = spawn(resolve(import.meta.dir, '../target/debug/ptyd'), [sock, String(cols), String(rows), '--', ...program], { cwd: dir, stdio: 'ignore', detached: true })
daemon.unref()
// wait until it listens (a bare connection: attaching would resize the program)
for (let i = 0; i < 80; i++) {
  const up = await new Promise<boolean>((ok) => { const c = connect(sock, () => { c.destroy(); ok(true) }); c.on('error', () => ok(false)) })
  if (up) break
  await sleep(100)
}

// A is there from the start: it has seen everything the program printed. It is the truth.
const a = new Client('live', cols, rows)
await a.attach(sock)
await sleep(Number(settleMs))
await a.settled()
const before = a.look()

// "the app is closed": nobody is attached for a while, the program keeps running
a.detach()
await sleep(1500)

// the app opens again: B attaches and gets the snapshot
const b = new Client('reattached', cols, rows)
await b.attach(sock)
await sleep(800)
await b.settled()
const after = b.look()

let diff = 0
const report: string[] = []
for (let y = 0; y < rows; y++) if (before.lines[y] !== after.lines[y]) { diff++; report.push(`  row ${y}\n    live: ${JSON.stringify(before.lines[y])}\n    back: ${JSON.stringify(after.lines[y])}`) }
let styleDiff = 0
for (let y = 0; y < rows; y++) if (before.styles[y] !== after.styles[y]) { styleDiff++; if (styleDiff <= 3) report.push(`  row ${y} colours/attributes differ\n    live: ${before.styles[y].slice(0, 120)}\n    back: ${after.styles[y].slice(0, 120)}`) }
const sameCursor = before.cursor.join() === after.cursor.join()
console.log(`[${label}] program: ${program.join(' ').slice(0, 60)}`)
console.log(`  snapshot: ${b.snapshotBytes} bytes; alt screen live=${before.alt} back=${after.alt}; cursor live=${before.cursor} back=${after.cursor} (${sameCursor ? 'same' : 'DIFFERENT'})`)
console.log(`  rows with text: ${before.lines.filter((l) => l.trim()).length}; rows that differ: ${diff}; rows whose colours/attributes differ: ${styleDiff}`)
if (report.length) console.log(report.slice(0, 6).join('\n'))
if (process.env.SHOW) console.log(before.lines.map((l, i) => String(i).padStart(2) + '| ' + l).join('\n'))

// the program still runs after the second client leaves too
b.detach()
try { process.kill(daemon.pid!, 'SIGKILL') } catch {}
rmSync(dir, { recursive: true, force: true })
process.exit(diff === 0 && styleDiff === 0 && sameCursor && before.alt === after.alt ? 0 : 1)
