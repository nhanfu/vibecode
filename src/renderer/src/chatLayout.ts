export type Dir = 'row' | 'col'
export type Tree<T> = T | { dir: Dir; kids: Tree<T>[] }
export type Layout = Tree<string>

export function isSplit<T>(n: Tree<T>): n is { dir: Dir; kids: Tree<T>[] } {
  return typeof n === 'object' && n !== null
}

export function mapLeaves<A, B>(n: Tree<A>, f: (leaf: A) => Tree<B> | null): Tree<B> | null {
  if (!isSplit(n)) return f(n)
  const kids: Tree<B>[] = []
  for (const k of n.kids) {
    const m = mapLeaves(k, f)
    if (m === null) continue
    if (isSplit(m) && m.dir === n.dir) kids.push(...m.kids)
    else kids.push(m)
  }
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  return { dir: n.dir, kids }
}

export function appendLayout(cur: Layout | null, id: string, dir: Dir): Layout {
  if (cur === null) return id
  return mapLeaves<string, string>({ dir, kids: [cur, id] }, (l) => l) ?? cur
}

export function swapLeaves(n: Layout, a: string, b: string): Layout {
  return mapLeaves(n, (id) => (id === a ? b : id === b ? a : id)) ?? n
}

/** An empty cell of a grid: a leaf that is not a chat. */
export const isSlot = (id: string): boolean => id.startsWith('slot:')
let slotSeq = 0
export function newSlot(): string {
  return `slot:${Date.now().toString(36)}${(slotSeq++).toString(36)}`
}
export function firstSlot(n: Layout | null): string | null {
  return layoutIds(n).find(isSlot) ?? null
}

/** A rows × cols grid: the first cells hold `ids` in order, the rest are empty slots. */
export function templateLayout(rows: number, cols: number, ids: string[]): Layout {
  const cells: Layout[] = []
  for (let i = 0; i < rows * cols; i++) cells.push(ids[i] ?? newSlot())
  const lines: Layout[] = []
  for (let r = 0; r < rows; r++) {
    const line = cells.slice(r * cols, (r + 1) * cols)
    lines.push(line.length === 1 ? line[0] : { dir: 'row', kids: line })
  }
  return lines.length === 1 ? lines[0] : { dir: 'col', kids: lines }
}

/** Keeps the layout in step with the chats: gone chats leave, new ones take the first empty slot (or join at the end). */
export function reconcileLayout(cur: Layout | null, ids: string[]): Layout | null {
  let out = cur === null ? null : mapLeaves<string, string>(cur, (id) => (ids.includes(id) || isSlot(id) ? id : null))
  for (const id of ids) {
    if (layoutIds(out).includes(id)) continue
    const slot = firstSlot(out)
    out = slot && out ? replaceLayout(out, slot, id) : joinLayout(out, null, id, 'row')
  }
  return out
}

export function layoutIds(n: Layout | null): string[] {
  const out: string[] = []
  if (n === null) return out
  mapLeaves(n, (id) => {
    out.push(id)
    return id
  })
  return out
}

export function splitLayout(n: Layout, at: string, id: string, dir: Dir): Layout {
  if (!isSplit(n)) return n === at ? { dir, kids: [at, id] } : n
  const i = n.kids.indexOf(at)
  if (i >= 0 && n.dir === dir) return { dir, kids: [...n.kids.slice(0, i + 1), id, ...n.kids.slice(i + 1)] }
  return { dir: n.dir, kids: n.kids.map((k) => splitLayout(k, at, id, dir)) }
}

export function replaceLayout(n: Layout, from: string, to: string): Layout {
  return mapLeaves(n, (id) => (id === from ? to : id)) ?? n
}

export function removeLayout(n: Layout, id: string): Layout | null {
  return mapLeaves(n, (x) => (x === id ? null : x))
}

export function layoutKey(cwd: string): string {
  return cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function gridLayout(ids: string[]): Layout | null {
  if (ids.length === 0) return null
  const cols = Math.ceil(Math.sqrt(ids.length))
  const rows: Layout[] = []
  for (let i = 0; i < ids.length; i += cols) {
    const row = ids.slice(i, i + cols)
    rows.push(row.length === 1 ? row[0] : { dir: 'row', kids: row })
  }
  return rows.length === 1 ? rows[0] : { dir: 'col', kids: rows }
}

export function joinLayout(cur: Layout | null, at: string | null, id: string, dir: Dir): Layout {
  if (at === null) {
    if (cur === null) return id
    return mapLeaves<string, string>({ dir: 'row', kids: [cur, id] }, (l) => l) ?? cur
  }
  if (cur === null) return { dir, kids: [at, id] }
  const base: Layout = layoutIds(cur).includes(at) ? cur : { dir, kids: [cur, at] }
  const next = splitLayout(base, at, id, dir)
  return mapLeaves(next, (l) => l) ?? next
}
