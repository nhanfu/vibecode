/**
 * Every app command, and the keys that run them, VS Code style: rules of `{ key, command, when }`
 * (DEFAULT_KEYS below, then the user's `keybindings.json` on top — see keybindings.ts). The global
 * key handler and the command palette (Ctrl+Shift+P / F1) both read them, so a shortcut shown in the
 * palette is always the one that works.
 *
 * Bindings follow VS Code (and Windows Terminal for the terminal keys). Keys that mean something
 * inside a terminal — readline (Ctrl+W, Ctrl+L…) and Claude Code (Ctrl+O transcript, Ctrl+J
 * newline, Ctrl+T todos…) — carry `!terminalFocus`, so they go to the terminal when it has the
 * cursor. Ctrl+B toggles the sidebar everywhere; `{ "key": "ctrl+b", "command": "passToTerminal",
 * "when": "chatFocus" }` in keybindings.json gives it back to Claude Code (run in background).
 */
import { useStore } from './store'
import {
  closeChat,
  closeTab,
  cycleChat,
  cycleTab,
  defaultAgent,
  newChat,
  newShell,
  openBrowser,
  openFolder,
  openFile,
  reopenClosedTab,
  selectChat,
  toggleBottom,
  toggleTheme
} from './actions'
import { focusTerm } from './terminals'
import { saveFile } from './fileModelsLite'
import { buildBindings, keysFor, pressOf, resolve, type Binding, type Context, type KeyRule } from './keybindings'

export interface Command {
  id: string
  label: string
  /** shown in the palette, e.g. "Ctrl+Shift+P": the key that runs it now (defaults + keybindings.json) */
  keys?: string
  run: () => void
}

const st = useStore.getState

const activeFile = (): { path: string; dirty: boolean } | null => {
  const s = st()
  const t = s.tabs.find((x) => x.id === s.activeTabId)
  return t?.kind === 'file' ? { path: t.path, dirty: t.dirty } : null
}

const showCode = (codeSide: 'files' | 'changes'): void => useStore.setState({ centerView: 'code', codeSide })
const palette = (query: string): void => useStore.setState({ quickOpen: true, quickOpenQuery: query })

export const COMMANDS: Command[] = [
  { id: 'palette', label: 'Show all commands', run: () => palette('>') },
  { id: 'quickOpen', label: 'Go to file…', run: () => st().root && palette('') },
  { id: 'symbol', label: 'Go to symbol in file…', run: () => window.dispatchEvent(new Event('go-to-symbol')) },
  { id: 'line', label: 'Go to line…', run: () => window.dispatchEvent(new Event('go-to-line')) },
  { id: 'openFolder', label: 'Open folder…', run: () => void openFolder(null, { autoChat: false }) },

  { id: 'newChat', label: 'New chat', run: () => void (defaultAgent() && newChat()) },
  { id: 'nextChat', label: 'Next chat', run: () => cycleChat(1) },
  { id: 'prevChat', label: 'Previous chat', run: () => cycleChat(-1) },
  { id: 'focusChat', label: 'Focus chat', run: () => focusActiveChat() },
  {
    id: 'closeChat',
    label: 'Close chat',
    run: () => {
      const id = st().activeChatId
      if (id) closeChat(id)
    }
  },

  { id: 'save', label: 'Save file', run: () => saveActive() },
  { id: 'closeTab', label: 'Close editor tab', run: () => closeActiveTab() },
  { id: 'reopenTab', label: 'Reopen closed editor tab', run: () => reopenClosedTab() },
  { id: 'nextTab', label: 'Next editor tab', run: () => cycleTab(1) },
  { id: 'prevTab', label: 'Previous editor tab', run: () => cycleTab(-1) },

  { id: 'explorer', label: 'Show Explorer (files)', run: () => showCode('files') },
  { id: 'changes', label: 'Show Source Control (changes)', run: () => showCode('changes') },
  { id: 'chats', label: 'Show chats sidebar', run: () => useStore.setState({ sidebarView: 'chats', sidebarOpen: true }) },
  { id: 'sidebar', label: 'Toggle sidebar', run: () => useStore.setState({ sidebarOpen: !st().sidebarOpen }) },
  { id: 'terminal', label: 'Toggle terminal', run: () => toggleBottom() },
  { id: 'panel', label: 'Toggle bottom panel', run: () => toggleBottom() },
  { id: 'newTerminal', label: 'New terminal', run: () => newShell() },

  { id: 'viewCode', label: 'Show Source code tab', run: () => useStore.setState({ centerView: 'code' }) },
  { id: 'viewWeb', label: 'Show Web tab', run: () => openBrowser() },
  { id: 'viewDb', label: 'Show Database tab', run: () => useStore.setState({ centerView: 'db' }) },
  { id: 'viewZalo', label: 'Show Zalo tab', run: () => useStore.setState({ centerView: 'zalo' }) },

  { id: 'theme', label: 'Toggle light / dark theme', run: () => void toggleTheme() },
  { id: 'keybindings', label: 'Open keyboard shortcuts (keybindings.json)', run: () => void openKeybindings() },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `chat${n}`, label: `Switch to chat ${n}`, run: () => switchChat(n) })),
  {
    id: 'passToTerminal',
    label: 'Send the key to the terminal (for keybindings.json)',
    // as a binding, it lets the key through to the terminal; from the palette there's no key to send
    run: () => {}
  }
]

const byId = new Map(COMMANDS.map((c) => [c.id, c]))

function focusActiveChat(): void {
  const id = st().activeChatId
  if (id) focusTerm(id)
}

function saveActive(): void {
  const f = activeFile()
  if (f) void saveFile(f.path)
}

function closeActiveTab(): void {
  const id = st().activeTabId
  if (id && st().centerView === 'code') closeTab(id)
}

function switchChat(n: number): void {
  const c = st().chats[n - 1]
  if (c) selectChat(c.id)
}

/* ---------------- the keys ---------------- */

/**
 * The built-in rules. Later rules win over earlier ones, and keybindings.json comes after all of
 * these. `when` contexts: see context() below.
 */
export const DEFAULT_KEYS: KeyRule[] = [
  { key: 'ctrl+shift+p', command: 'palette' },
  { key: 'f1', command: 'palette' },
  { key: 'ctrl+p', command: 'quickOpen', when: 'hasFolder' },
  { key: 'ctrl+shift+o', command: 'symbol' },
  // Monaco opens its own "go to line" when it has the cursor
  { key: 'ctrl+g', command: 'line', when: '!terminalFocus && !editorFocus && !textInputFocus' },
  { key: 'ctrl+o', command: 'openFolder', when: '!terminalFocus && !textInputFocus' },

  { key: 'ctrl+shift+n', command: 'newChat' },
  { key: 'ctrl+alt+right', command: 'nextChat' },
  { key: 'ctrl+alt+left', command: 'prevChat' },
  { key: 'ctrl+shift+l', command: 'focusChat' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: `alt+${n}`, command: `chat${n}` })),

  // nothing unsaved: the key is left alone
  { key: 'ctrl+s', command: 'save', when: '!terminalFocus && fileDirty' },
  { key: 'ctrl+w', command: 'closeTab', when: "!terminalFocus && !textInputFocus && centerView == 'code'" },
  { key: 'ctrl+f4', command: 'closeTab', when: "!terminalFocus && centerView == 'code'" },
  { key: 'ctrl+shift+t', command: 'reopenTab' },
  { key: 'ctrl+tab', command: 'nextTab' },
  { key: 'ctrl+pagedown', command: 'nextTab' },
  { key: 'ctrl+shift+tab', command: 'prevTab' },
  { key: 'ctrl+pageup', command: 'prevTab' },

  { key: 'ctrl+shift+e', command: 'explorer' },
  { key: 'ctrl+shift+g', command: 'changes' },
  // Ctrl+Shift+C in a terminal copies (Windows Terminal / VS Code)
  { key: 'ctrl+shift+c', command: 'chats', when: '!terminalFocus' },
  { key: 'ctrl+b', command: 'sidebar' },
  { key: 'ctrl+`', command: 'terminal' },
  { key: 'ctrl+j', command: 'panel', when: '!terminalFocus && !textInputFocus' },
  { key: 'ctrl+shift+`', command: 'newTerminal' },

  // in a terminal too: shells don't use them
  { key: 'ctrl+1', command: 'viewCode' },
  { key: 'ctrl+2', command: 'viewWeb' },
  { key: 'ctrl+3', command: 'viewDb' },
  { key: 'ctrl+4', command: 'viewZalo' }
]

/** The cursor is in a text field of the page (not Monaco or a terminal, which handle their own keys). */
const inTextField = (el: HTMLElement | null): boolean =>
  !!el && !el.closest('.monaco-editor') && !el.closest('.xterm') && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

/** What `when` clauses can test. Listed in the comment at the top of a new keybindings.json. */
function context(): Context {
  const el = document.activeElement as HTMLElement | null
  const term = el?.closest?.('.xterm') ? (el.closest('.xterm-host') as HTMLElement | null) : null
  const editor = !!el?.closest?.('.monaco-editor')
  const field = inTextField(el)
  const s = st()
  return {
    terminalFocus: !!term,
    chatFocus: !!term && term.dataset.kind === 'claude',
    shellFocus: !!term && term.dataset.kind === 'shell',
    editorFocus: editor,
    textInputFocus: field,
    inputFocus: editor || field,
    sidebarOpen: s.sidebarOpen,
    hasFolder: !!s.root,
    fileDirty: !!activeFile()?.dirty,
    centerView: s.centerView
  }
}
const CONTEXT_HELP = [
  'terminalFocus      the cursor is in a terminal (a chat or a shell)',
  'chatFocus          … in a chat (Claude Code or another coding agent)',
  'shellFocus         … in a shell terminal',
  'editorFocus        … in the code editor',
  'textInputFocus     … in a text box (address bar, search, filter…)',
  'inputFocus         editorFocus || textInputFocus',
  'sidebarOpen        the sidebar is pinned open',
  'hasFolder          a project folder is open',
  'fileDirty          the open file has unsaved changes',
  "centerView         'code' | 'web' | 'db' | 'zalo'   e.g. centerView == 'code'"
]

let bindings: Binding[] = []
let lastProblems = ''

function apply(text: string | null): void {
  const built = buildBindings(DEFAULT_KEYS, text, (id) => byId.has(id))
  bindings = built.bindings
  for (const c of COMMANDS) c.keys = keysFor(bindings, c.id)
  const problems = built.problems.join('\n')
  if (problems && problems !== lastProblems) {
    console.warn('[keybindings]', problems)
    window.alert(`keybindings.json — these rules were skipped:\n\n${problems}`)
  }
  lastProblems = problems
}

async function loadKeybindings(): Promise<void> {
  apply(await window.api.keybindings.read().catch(() => null))
}

/** A new keybindings.json: how to write rules, every command id, and the defaults (commented out). */
function template(): string {
  const width = Math.max(...COMMANDS.map((c) => c.id.length)) + 2
  const lines = [
    '// Keyboard shortcuts, in VS Code\'s format. Rules here come after the defaults and win over them:',
    '// for a key press, the last rule whose key matches and whose "when" holds runs its command.',
    '// The file applies as soon as it is saved.',
    '//',
    '//   { "key": "ctrl+b", "command": "sidebar", "when": "!editorFocus" }',
    '//   { "key": "ctrl+k ctrl+t", "command": "theme" }                  a chord: one key, then the other',
    '//   { "key": "ctrl+b", "command": "-sidebar" }                      remove the default Ctrl+B → sidebar',
    '//   { "key": "ctrl+b", "command": "passToTerminal", "when": "chatFocus" }   Ctrl+B goes to Claude Code',
    '//',
    '// Keys: ctrl shift alt + a-z 0-9 f1-f12 ` - = [ ] \\ ; \' , . / space enter tab escape backspace',
    '//       delete insert home end pageup pagedown left right up down numpad0-9   (Cmd counts as Ctrl)',
    '//',
    '// "when": names, ! && || == != and parentheses. Names:',
    ...CONTEXT_HELP.map((l) => '//   ' + l),
    '//',
    '// Commands:',
    ...COMMANDS.map((c) => `//   ${c.id.padEnd(width)}${c.label}`),
    '//',
    '// Defaults:',
    ...DEFAULT_KEYS.map((r) => '//   ' + JSON.stringify(r).replace(/"(\w+)":/g, '"$1": ').replace(/,"/g, ', "')),
    '[',
    ']',
    ''
  ]
  return lines.join('\n')
}

/** Open keybindings.json in the editor, writing the commented template first if there is none yet. */
async function openKeybindings(): Promise<void> {
  const path = await window.api.keybindings.path()
  const text = await window.api.keybindings.read().catch(() => null)
  if (text === null) await window.api.fs.writeFile(path, template())
  useStore.setState({ centerView: 'code' })
  openFile(path)
}

// before the first key press; again on every save of the file
apply(null)
void loadKeybindings()
window.api.keybindings.onChanged(() => void loadKeybindings())

/** The page is a web view: its reload keys would wipe every chat's screen. */
function isReload(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey
  return e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')
}

/** The first key of a chord ("ctrl+k" of "ctrl+k ctrl+t"), waiting for the second. */
let pending: string | null = null

export function onGlobalKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  const inTerminal = !!(document.activeElement as HTMLElement | null)?.closest?.('.xterm')
  if (isReload(e) && !inTerminal) {
    // Ctrl+Shift+R still reloads while developing
    if (!(import.meta.env.DEV && e.shiftKey)) e.preventDefault()
    return
  }
  // a key the input method is using to compose a word (Unikey, Telex…)
  if (e.isComposing || e.keyCode === 229) return
  const press = pressOf(e)
  if (!press) return
  const r = resolve(bindings, press, pending, context())
  pending = null
  if (r.kind === 'none') return
  // the rule says: this key is the terminal's
  if (r.kind === 'run' && r.command === 'passToTerminal') return
  e.preventDefault()
  e.stopPropagation()
  if (r.kind === 'chord') pending = r.first
  else if (r.kind === 'run') byId.get(r.command)?.run()
}
