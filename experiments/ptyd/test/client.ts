import { connect, type Socket } from 'node:net'
import xterm from '@xterm/headless'

/** A client of ptyd that keeps an xterm (the parser the app's terminal uses) in step with what it hears. */
export class Client {
  term: any
  sock!: Socket
  exited: number | null = null
  snapshotBytes = 0
  private buf = Buffer.alloc(0)
  private pending: Promise<void> = Promise.resolve()

  constructor(public name: string, public cols: number, public rows: number) {
    this.term = new (xterm as any).Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
  }

  static frame(kind: string, payload: Buffer): Buffer {
    const h = Buffer.alloc(5)
    h.write(kind, 0, 'latin1')
    h.writeUInt32BE(payload.length, 1)
    return Buffer.concat([h, payload])
  }

  attach(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = connect(path, () => {
        const size = Buffer.alloc(4)
        size.writeUInt16BE(this.cols, 0)
        size.writeUInt16BE(this.rows, 2)
        this.sock.write(Client.frame('A', size))
        resolve()
      })
      this.sock.on('error', reject)
      this.sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d])
        while (this.buf.length >= 5) {
          const len = this.buf.readUInt32BE(1)
          if (this.buf.length < 5 + len) break
          const kind = String.fromCharCode(this.buf[0])
          const body = this.buf.subarray(5, 5 + len)
          this.buf = this.buf.subarray(5 + len)
          if (kind === 'S') this.snapshotBytes += body.length
          if (kind === 'X') this.exited = body.readInt32BE(0)
          if (kind === 'S' || kind === 'D') this.pending = this.pending.then(() => new Promise<void>((r) => this.term.write(body, r)))
        }
      })
    })
  }

  type(text: string): void {
    this.sock.write(Client.frame('I', Buffer.from(text)))
  }
  detach(): void {
    this.sock.destroy()
  }
  settled(): Promise<void> {
    return this.pending
  }

  /** What is on screen, line by line (trailing blanks cut), and the cursor, and which buffer is shown. */
  look(): { lines: string[]; styles: string[]; cursor: [number, number]; alt: boolean } {
    const b = this.term.buffer.active
    const lines: string[] = []
    const styles: string[] = []
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(y)
      lines.push(line?.translateToString(true) ?? '')
      // colours and attributes of every cell that holds a character (a blank cell's colours show only if it has a background)
      let sig = ''
      for (let x = 0; x < this.cols; x++) {
        const c = line?.getCell(x)
        if (!c) continue
        const blank = c.getChars() === '' || c.getChars() === ' '
        if (blank && c.getBgColorMode() === 0 && !c.isInverse()) continue
        sig += `${x}:${c.getFgColorMode()}.${c.getFgColor()}/${c.getBgColorMode()}.${c.getBgColor()}/${+c.isBold()}${+c.isItalic()}${+c.isUnderline()}${+c.isInverse()}${+c.isDim()} `
      }
      styles.push(sig)
    }
    return { lines, styles, cursor: [b.cursorX, b.cursorY], alt: b.type === 'alternate' }
  }
}
