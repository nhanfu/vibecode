import { Client } from './client'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function start(cols: number, rows: number, ...program: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ptyd-')); const sock = join(dir, 's.sock')
  const d = spawn(resolve(import.meta.dir, '../target/debug/ptyd'), [sock, String(cols), String(rows), '--', ...program], { cwd: dir, stdio: 'ignore', detached: true }); d.unref()
  for (let i = 0; i < 80; i++) { if (await new Promise<boolean>((ok) => { const c = connect(sock, () => { c.destroy(); ok(true) }); c.on('error', () => ok(false)) })) break; await sleep(100) }
  return { dir, sock, stop: () => { try { process.kill(d.pid!, 'SIGKILL') } catch {} rmSync(dir, { recursive: true, force: true }) } }
}
let ok = true
const check = (name: string, pass: boolean, note = '') => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); ok &&= pass }

// 1. keystrokes sent after re-attaching reach the program, and the next re-attach sees the result
{
  const s = await start(110, 32, 'less', '/etc/services')
  const a = new Client('a', 110, 32); await a.attach(s.sock); await sleep(1500); a.detach(); await sleep(500)
  const b = new Client('b', 110, 32); await b.attach(s.sock); await sleep(500)
  b.type('G'); await sleep(800); b.detach(); await sleep(500)          // jump to the end of the file, then leave
  const c = new Client('c', 110, 32); await c.attach(s.sock); await sleep(800); await c.settled()
  const last = c.look().lines.filter((l) => l.trim())
  check('input after re-attach reaches the program, state survives another detach', last.some((l) => /\(END\)|^#|iana|\/tcp|\/udp/.test(l)) && !last[0].includes('# Network services'), last[0].slice(0, 60))
  s.stop()
}

// 2. re-attaching with another window size: the program is resized and redraws, and it matches a fresh run at that size
{
  const s = await start(110, 32, 'less', '/etc/services')
  const a = new Client('a', 110, 32); await a.attach(s.sock); await sleep(1500); a.detach(); await sleep(500)
  const b = new Client('b', 90, 28); await b.attach(s.sock); await sleep(1500); await b.settled()
  const fresh = await start(90, 28, 'less', '/etc/services')
  const f = new Client('f', 90, 28); await f.attach(fresh.sock); await sleep(1500); await f.settled()
  const [x, y] = [b.look(), f.look()]
  // less prints its own prompt on the last row differently after a resize (':') than on a first draw (the file name)
  const diff = x.lines.filter((l, i) => i < 27 && l !== y.lines[i]).length
  check('re-attach at another size matches a fresh run at that size (all but the prompt row of less)', diff === 0 && x.alt === y.alt, `${diff} rows differ`)
  x.lines.forEach((l, i) => { if (l !== y.lines[i]) console.log(`      row ${i}\n        re-attached: ${JSON.stringify(l)}\n        fresh:       ${JSON.stringify(y.lines[i])}`) })
  s.stop(); fresh.stop()
}

// 3. the program keeps running with nobody attached, and a program that ends is reported
{
  const s = await start(80, 10, 'sh', '-c', 'echo start; sleep 3; echo done-after-3s')
  const a = new Client('a', 80, 10); await a.attach(s.sock); await sleep(500); a.detach()
  await sleep(3500)                                                      // the program finishes while nobody watches
  const b = new Client('b', 80, 10); await b.attach(s.sock).catch(() => {}); await sleep(500); await b.settled()
  const text = b.look().lines.join('\n')
  check('output produced while detached is on the screen at re-attach', text.includes('done-after-3s'), text.split('\n').filter(Boolean).join(' / '))
  s.stop()
}
process.exit(ok ? 0 : 1)
