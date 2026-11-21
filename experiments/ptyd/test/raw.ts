import { Client } from './client'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'ptyd-')); const sock = join(dir, 's.sock')
const d = spawn(resolve(import.meta.dir, '../target/debug/ptyd'), [sock, '110', '32', '--', 'claude'], { cwd: dir, stdio: 'ignore', detached: true }); d.unref()
for (let i = 0; i < 80; i++) { if (await new Promise<boolean>((ok) => { const c = connect(sock, () => { c.destroy(); ok(true) }); c.on('error', () => ok(false)) })) break; await sleep(100) }
const a = new Client('raw', 110, 32); const chunks: Buffer[] = []
await a.attach(sock); a.sock.on('data', (x) => chunks.push(Buffer.from(x)))
await sleep(10000)
const all = Buffer.concat(chunks).toString('latin1')
const i = all.indexOf('Security guide')
console.log(JSON.stringify(all.slice(Math.max(0, i - 140), i + 40)))
console.log('OSC 8 present:', all.includes('\x1b]8;'))
try { process.kill(d.pid!, 'SIGKILL') } catch {}
rmSync(dir, { recursive: true, force: true }); process.exit(0)
