/** One side of a side-by-side row: the line's number and text, or nothing (`empty`) where the other side has more lines. */
export interface DiffCell {
  n: number | null
  text: string
  kind: 'eq' | 'del' | 'add' | 'empty'
  /** the line split into coloured pieces (set by attachTokens) */
  tokens?: Span[]
}

/** A piece of a line and its colour class ('kw', 'str', … or '' for plain text). */
export interface Span {
  text: string
  cls: string
}

/** Monaco's tokens of one line: where each token starts and its scope (e.g. 'keyword.ts'). */
export type LineTokens = { offset: number; type: string }[]

const CLASS_OF: Record<string, string> = {
  keyword: 'kw',
  string: 'str',
  regexp: 'str',
  comment: 'cm',
  number: 'num',
  type: 'ty',
  function: 'fn',
  tag: 'kw',
  attribute: 'ty',
  constant: 'num',
  variable: 'var'
}

function spansOf(text: string, line: LineTokens | undefined): Span[] {
  if (!line || line.length === 0) return [{ text, cls: '' }]
  const out: Span[] = []
  line.forEach((tok, k) => {
    const end = k + 1 < line.length ? line[k + 1].offset : text.length
    const piece = text.slice(tok.offset, end)
    if (piece) out.push({ text: piece, cls: CLASS_OF[tok.type.split('.')[0]] ?? '' })
  })
  return out
}

/** Gives each cell its coloured pieces: left cells read the old file's lines, right cells the new file's. */
export function attachTokens(rows: DiffRow[], oldTokens: LineTokens[], newTokens: LineTokens[]): void {
  for (const r of rows) {
    if (r.left.n !== null && r.left.kind !== 'empty') r.left.tokens = spansOf(r.left.text, oldTokens[r.left.n - 1])
    if (r.right.n !== null && r.right.kind !== 'empty') r.right.tokens = spansOf(r.right.text, newTokens[r.right.n - 1])
  }
}

export interface DiffRow {
  left: DiffCell
  right: DiffCell
}

const EMPTY: DiffCell = { n: null, text: '', kind: 'empty' }

const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/**
 * Line diff of two texts, laid out as rows for a side-by-side view. Unchanged lines sit on both sides;
 * a run of removed and added lines is paired row by row. Returns null when the middle part is too big
 * for the table (the caller says so instead).
 */
export function sideBySide(oldText: string, newText: string): DiffRow[] | null {
  const a = lines(oldText)
  const b = lines(newText)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const n = am.length
  const m = bm.length
  if (n * m > 4_000_000) return null

  // longest common subsequence of the middle parts, then walk it into operations
  const W = m + 1
  const dp = new Uint32Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = am[i] === bm[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1])
    }
  }
  type Op = { t: 'eq' | 'del' | 'add'; i: number; j: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      ops.push({ t: 'eq', i, j })
      i++
      j++
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ t: 'del', i, j })
      i++
    } else {
      ops.push({ t: 'add', i, j })
      j++
    }
  }
  while (i < n) ops.push({ t: 'del', i: i++, j })
  while (j < m) ops.push({ t: 'add', i, j: j++ })

  const rows: DiffRow[] = []
  for (let k = 0; k < pre; k++) {
    rows.push({ left: { n: k + 1, text: a[k], kind: 'eq' }, right: { n: k + 1, text: b[k], kind: 'eq' } })
  }
  let p = 0
  while (p < ops.length) {
    const op = ops[p]
    if (op.t === 'eq') {
      rows.push({
        left: { n: pre + op.i + 1, text: am[op.i], kind: 'eq' },
        right: { n: pre + op.j + 1, text: bm[op.j], kind: 'eq' }
      })
      p++
      continue
    }
    const dels: Op[] = []
    const adds: Op[] = []
    while (p < ops.length && ops[p].t !== 'eq') {
      if (ops[p].t === 'del') dels.push(ops[p])
      else adds.push(ops[p])
      p++
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k]
      const ad = adds[k]
      rows.push({
        left: d ? { n: pre + d.i + 1, text: am[d.i], kind: 'del' } : EMPTY,
        right: ad ? { n: pre + ad.j + 1, text: bm[ad.j], kind: 'add' } : EMPTY
      })
    }
  }
  for (let k = suf; k > 0; k--) {
    const li = a.length - k
    const ri = b.length - k
    rows.push({ left: { n: li + 1, text: a[li], kind: 'eq' }, right: { n: ri + 1, text: b[ri], kind: 'eq' } })
  }
  return rows
}
