/**
 * Keyboard shortcuts the VS Code way: a list of `{ key, command, when }` rules. The defaults come
 * from shortcuts.ts, the user's `keybindings.json` is added after them, and for a key press the
 * last rule whose key matches and whose `when` holds wins. A user rule whose command starts with
 * "-" removes default rules for that command instead (only those with the same key / when, if given).
 *
 * Pure logic, no app state: the caller hands in the context the `when` clauses read.
 */

export interface KeyRule {
  /** "ctrl+shift+p", or a chord "ctrl+k ctrl+t" */
  key: string
  command: string
  when?: string
}

/** What `when` clauses can read: true/false flags and string values (`floating == 'web'`). */
export type Context = Record<string, string | boolean | undefined>

/** A rule that is ready to match: its key in canonical form and its `when` compiled. */
export interface Binding {
  key: string
  command: string
  when?: string
  test: (ctx: Context) => boolean
  /** the user's file, not the defaults */
  user: boolean
}

/* ---------------- keys ---------------- */

const MODS = ['ctrl', 'shift', 'alt'] as const

const ALIASES: Record<string, string> = {
  control: 'ctrl',
  // Cmd (and the Windows key, as a rule's modifier) count as Ctrl: see pressOf
  cmd: 'ctrl',
  meta: 'ctrl',
  win: 'ctrl',
  super: 'ctrl',
  option: 'alt',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  backtick: '`',
  plus: '='
}

/** One key press in canonical form: modifiers in a fixed order, then the key ("ctrl+shift+p"). */
function canonPress(s: string): string | null {
  const parts = s
    .trim()
    .toLowerCase()
    .split(/\+(?!$)/)
    .map((p) => ALIASES[p.trim()] ?? p.trim())
  const key = parts.pop()
  if (!key || parts.some((p) => !(MODS as readonly string[]).includes(p))) return null
  return [...MODS.filter((m) => parts.includes(m)), key].join('+')
}

/** A rule's key in canonical form ("ctrl+k ctrl+t" for chords), or null when it can't be read. */
export function canonKey(s: string): string | null {
  const presses = s.trim().split(/\s+/).map(canonPress)
  return presses.length && presses.length <= 2 && presses.every(Boolean) ? presses.join(' ') : null
}

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'space'
}

/**
 * A key event as the rules write it. The physical key (`e.code`) decides, so a binding stays on the
 * same key whatever the layout, and Shift doesn't turn "ctrl+shift+1" into "ctrl+shift+!".
 * The Cmd key counts as Ctrl, so the rules read the same on a Mac.
 */
export function pressOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | null {
  let key: string
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad[0-9]$/.test(e.code)) key = 'numpad' + e.code.slice(6)
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]
  else key = e.key.toLowerCase()
  key = ALIASES[key] ?? key
  if (!key || key === 'unidentified' || key === 'dead' || key === 'process') return null
  // a modifier on its own is not a press yet
  if (['ctrl', 'shift', 'alt', 'meta'].includes(key)) return null
  const mods = [e.ctrlKey || e.metaKey ? 'ctrl' : '', e.shiftKey ? 'shift' : '', e.altKey ? 'alt' : ''].filter(Boolean)
  return [...mods, key].join('+')
}

const LABELS: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓', pageup: 'PageUp', pagedown: 'PageDown', escape: 'Esc' }

/** "ctrl+shift+p" → "Ctrl+Shift+P", for the palette. */
export function keyLabel(key: string): string {
  return key
    .split(' ')
    .map((press) =>
      press
        .split(/\+(?!$)/)
        .map((p) => LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
        .join('+')
    )
    .join(' ')
}

/* ---------------- when clauses ---------------- */

type Tok = { t: 'id' | 'str' | 'op'; v: string }

function tokens(src: string): Tok[] {
  const out: Tok[] = []
  const re = /\s*(?:(&&|\|\||==|!=|!|\(|\))|'([^']*)'|"([^"]*)"|([A-Za-z_][\w.:-]*))/y
  let i = 0
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break
    re.lastIndex = i
    const m = re.exec(src)
    if (!m) throw new Error(`can't read "${src.slice(i).trim()}"`)
    if (m[1]) out.push({ t: 'op', v: m[1] })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'str', v: m[2] ?? m[3] })
    else out.push({ t: 'id', v: m[4] })
    i = re.lastIndex
  }
  return out
}

/**
 * Compile a `when` clause: names (true when the context value is truthy), `!`, `&&`, `||`,
 * parentheses, and `name == value` / `name != value` with a quoted or bare value. Throws on a typo,
 * so a broken rule is reported rather than quietly matching everywhere.
 */
export function compileWhen(src: string | undefined): (ctx: Context) => boolean {
  if (!src || !src.trim()) return () => true
  const toks = tokens(src)
  let i = 0
  const peek = (): Tok | undefined => toks[i]
  const eat = (v: string): boolean => (peek()?.t === 'op' && peek()!.v === v ? (i++, true) : false)

  type Fn = (ctx: Context) => boolean
  const or = (): Fn => {
    let f = and()
    while (eat('||')) {
      const a = f
      const b = and()
      f = (c) => a(c) || b(c)
    }
    return f
  }
  const and = (): Fn => {
    let f = not()
    while (eat('&&')) {
      const a = f
      const b = not()
      f = (c) => a(c) && b(c)
    }
    return f
  }
  const not = (): Fn => {
    if (eat('!')) {
      const f = not()
      return (c) => !f(c)
    }
    return compare()
  }
  const compare = (): Fn => {
    if (eat('(')) {
      const f = or()
      if (!eat(')')) throw new Error('missing ")"')
      return f
    }
    const name = peek()
    if (!name || name.t !== 'id') throw new Error(name ? `unexpected "${name.v}"` : 'ends too early')
    i++
    if (name.v === 'true') return () => true
    if (name.v === 'false') return () => false
    for (const op of ['==', '!=']) {
      if (!eat(op)) continue
      const val = peek()
      if (!val || val.t === 'op') throw new Error(`a value must follow "${op}"`)
      i++
      const eq = (c: Context): boolean => String(c[name.v] ?? '') === val.v
      return op === '==' ? eq : (c) => !eq(c)
    }
    return (c) => !!c[name.v]
  }
  const f = or()
  if (i < toks.length) throw new Error(`unexpected "${toks[i].v}"`)
  return f
}

/* ---------------- the file ---------------- */

/** JSON with // and /* comments and trailing commas, as VS Code writes keybindings.json. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      // a string, escapes included, copied as is
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      out += ' '
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'))
}

/**
 * The defaults with the user's rules applied, plus what was wrong with the user's file (each
 * problem names the rule, which is skipped). `known` tells real commands from typos.
 */
export function buildBindings(defaults: KeyRule[], userText: string | null, known: (command: string) => boolean): { bindings: Binding[]; problems: string[] } {
  const problems: string[] = []
  const make = (r: KeyRule, user: boolean): Binding | null => {
    const key = canonKey(r.key)
    if (!key) {
      problems.push(`"${r.key}": not a key`)
      return null
    }
    try {
      return { key, command: r.command, when: r.when?.trim() || undefined, test: compileWhen(r.when), user }
    } catch (e) {
      problems.push(`"${r.key}" → ${r.command}: when "${r.when}": ${(e as Error).message}`)
      return null
    }
  }
  const bindings = defaults.map((r) => make(r, false)).filter((b): b is Binding => !!b)

  let rules: unknown = []
  if (userText?.trim()) {
    try {
      rules = parseJsonc(userText)
    } catch (e) {
      problems.push(`keybindings.json is not valid JSON: ${(e as Error).message}`)
    }
  }
  if (!Array.isArray(rules)) {
    problems.push('keybindings.json must be a list: [ { "key": …, "command": … } ]')
    rules = []
  }
  for (const r of rules as Partial<KeyRule>[]) {
    if (!r || typeof r !== 'object' || typeof r.command !== 'string') {
      problems.push(`${JSON.stringify(r)}: needs a "command"`)
      continue
    }
    if (r.command.startsWith('-')) {
      const command = r.command.slice(1)
      const key = r.key ? canonKey(r.key) : null
      if (r.key && !key) {
        problems.push(`"${r.key}": not a key`)
        continue
      }
      const when = r.when?.trim()
      for (let i = bindings.length - 1; i >= 0; i--) {
        const b = bindings[i]
        if (b.command === command && (!key || b.key === key) && (!when || b.when === when)) bindings.splice(i, 1)
      }
      continue
    }
    if (typeof r.key !== 'string') {
      problems.push(`${r.command}: needs a "key"`)
      continue
    }
    if (!known(r.command)) {
      problems.push(`"${r.key}": unknown command "${r.command}"`)
      continue
    }
    const b = make(r as KeyRule, true)
    if (b) bindings.push(b)
  }
  return { bindings, problems }
}

/* ---------------- matching ---------------- */

export type Resolution =
  /** run this command */
  | { kind: 'run'; command: string }
  /** the first half of a chord: swallow the key and wait for the second */
  | { kind: 'chord'; first: string }
  /** a chord's second key that matched nothing: swallow it (VS Code does too) */
  | { kind: 'swallow' }
  /** no rule: the key goes where it was going */
  | { kind: 'none' }

/**
 * What a key press means. `pending` is the first half of a chord pressed just before, if any.
 * Rules are searched from the last one, so the user's win over the defaults.
 */
export function resolve(bindings: Binding[], press: string, pending: string | null, ctx: Context): Resolution {
  const full = pending ? `${pending} ${press}` : press
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i]
    if (b.key === full && b.test(ctx)) return { kind: 'run', command: b.command }
  }
  if (pending) return { kind: 'swallow' }
  if (bindings.some((b) => b.key.startsWith(press + ' ') && b.test(ctx))) return { kind: 'chord', first: press }
  return { kind: 'none' }
}

/** The key the palette shows for a command: its last rule (the one that wins when several could). */
export function keysFor(bindings: Binding[], command: string): string | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i].command === command) return keyLabel(bindings[i].key)
  return undefined
}
