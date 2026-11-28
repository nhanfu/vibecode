/**
 * Every app command and the keys that run it, VS Code style. Rules `{ key, command, when }` come from
 * DEFAULT_KEYS below, then the user's `keybindings.json` (in the app's data folder, read at start and
 * on reload). For a key press the last rule whose key matches and whose `when` holds runs its command.
 * Context keys (`when`): see context().
 *
 * A key inside the herdr panel does not reach here: the panel is a frame with its own page.
 */
import { closeFloat, floating, focusPanel, PANEL_IDS, panelShown, showPanel, toggleFullscreen, togglePanel, useStore, type PanelId } from './store'
import { toggleTheme } from './actions'
import { buildBindings, keysFor, parseJsonc, pressOf, resolve, type Binding, type Context, type KeyRule } from './keybindings'

export interface Command {
  id: string
  label: string
  /** the key that runs it now (defaults + keybindings.json), shown next to it */
  keys?: string
  run: () => void
}

const st = useStore.getState

export const COMMANDS: Command[] = [
  { id: 'reloadApp', label: 'Reload app (also re-reads keybindings.json)', run: () => window.location.reload() },
  { id: 'theme', label: 'Toggle light / dark theme', run: () => void toggleTheme() },
  { id: 'viewPlugins', label: 'Show / hide Plugins', run: () => togglePanel('plugins') },
  { id: 'viewTerminal', label: 'Show / hide Terminal', run: () => togglePanel('terminal') },
  { id: 'closeFloat', label: 'Close the floating drop-down', run: () => closeFloat() },
  { id: 'keyboardShortcuts', label: 'Keyboard shortcuts: edit…', run: () => window.dispatchEvent(new Event('open-keybindings')) },
  { id: 'fullscreen', label: 'Mini-app full screen', run: () => toggleFullscreen(currentMiniApp()) },
  { id: 'miniAppPrev', label: 'Previous mini-app', run: () => cycleMiniApp(-1) },
  { id: 'miniAppNext', label: 'Next mini-app', run: () => cycleMiniApp(1) },
  // do nothing: swallows the key (F5 and Ctrl+R would reload the page by accident)
  { id: 'noop', label: 'Nothing', run: () => {} },
  // the key goes on to the focused page or terminal, instead of being handled here
  { id: 'passToTerminal', label: 'Send the key to the focused terminal (for keybindings.json)', run: () => {} }
]

const byId = new Map(COMMANDS.map((c) => [c.id, c]))

/** The mini-app the cursor is in, else the one floating, else the last pinned one. */
export function currentMiniApp(): PanelId {
  const s = st()
  if (s.fullscreen) return s.fullscreen
  const floated = floating(s)
  if (floated) return floated
  const here = (document.activeElement as HTMLElement | null)?.closest?.('.stack-panel')?.getAttribute('data-panel')
  if (here) return here as PanelId
  return [...s.panelOrder].reverse().find((p) => s.pinned.includes(p)) ?? 'plugins'
}

/** Ctrl+Shift+←/→: the previous or next mini-app in the title bar's order. */
export function cycleMiniApp(step: 1 | -1): void {
  const s = st()
  const list = s.panelOrder
  if (!list.length) return
  const i = list.indexOf(currentMiniApp())
  const next = list[(i < 0 ? 0 : i + step + list.length) % list.length]
  if (s.fullscreen) useStore.setState({ fullscreen: next, floatOpen: null, peek: null })
  else if (!s.pinned.includes(next)) showPanel(next)
  focusPanel(next)
}

/** The rules built in. Later rules win over earlier ones; keybindings.json comes after all of these. */
export const DEFAULT_KEYS: KeyRule[] = [
  { key: 'ctrl+shift+r', command: 'reloadApp' },
  { key: 'f5', command: 'noop' },
  { key: 'ctrl+r', command: 'noop', when: '!terminalFocus' },
  { key: 'ctrl+k ctrl+t', command: 'theme' },
  { key: 'ctrl+k ctrl+s', command: 'keyboardShortcuts' },
  { key: 'ctrl+shift+x', command: 'viewPlugins' },
  { key: 'f11', command: 'fullscreen' },
  { key: 'escape', command: 'fullscreen', when: 'fullscreenOn' },
  { key: 'ctrl+shift+left', command: 'miniAppPrev' },
  { key: 'ctrl+shift+right', command: 'miniAppNext' },
  { key: 'escape', command: 'closeFloat', when: "floating != ''" }
]

/** What `when` clauses can test. Listed in the comment at the top of a new keybindings.json. */
function context(): Context {
  const el = document.activeElement as HTMLElement | null
  const s = st()
  const field = !!el && !el.closest('.xterm') && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  return {
    terminalFocus: !!el?.closest?.('.xterm'),
    textInputFocus: field,
    inputFocus: field,
    floating: floating(s) ?? '',
    fullscreenOn: !!s.fullscreen,
    ...Object.fromEntries(PANEL_IDS.flatMap((id) => [[`${id}Shown`, panelShown(s, id)], [`${id}Pinned`, s.pinned.includes(id)]]))
  }
}

const CONTEXT_HELP = [
  'terminalFocus      the cursor is in a terminal',
  'textInputFocus     … in a text box',
  'inputFocus         textInputFocus',
  "floating           the drop-down floating now: 'plugins' | '', if none",
  'fullscreenOn       a mini-app is shown full screen',
  'pluginsShown       that drop-down is on screen (pinned or floating)',
  'pluginsPinned      … pinned in the stack'
]

let bindings: Binding[] = []
let lastProblems = ''
/** the text of keybindings.json as last read or saved (null: there is no file) */
let userText: string | null = null

/** Every binding in force, defaults and the user's, in the order they are searched (the last one wins). */
export function allBindings(): Binding[] {
  return bindings
}

/** The user's rules as the file has them now. */
export function userRules(): KeyRule[] {
  return userRulesOf(userText)
}

/** Writes the whole keybindings.json and applies it at once. */
export async function writeKeybindings(rules: KeyRule[]): Promise<void> {
  const text = '// Keyboard shortcuts. Later rules win over the defaults.\n' + JSON.stringify(rules, null, 2) + '\n'
  await window.api.keybindings.write(text)
  apply(text)
}

/** Builds the bindings from the defaults and the user's file, and shows what was skipped. */
function apply(text: string | null): void {
  userText = text
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

/** Reads keybindings.json from the app's data folder (none when there is no file). */
export async function loadKeybindings(): Promise<void> {
  const text = await window.api.keybindings.read().catch(() => null)
  apply(text)
}

/** The user's rules as they are in the file (for tools and checks). */
function userRulesOf(text: string | null): KeyRule[] {
  try {
    const v = parseJsonc(text ?? '[]')
    return Array.isArray(v) ? (v as KeyRule[]) : []
  } catch {
    return []
  }
}

/** F5 and Ctrl+R would reload the page by accident; Ctrl+Shift+R is the reloadApp command. */
let pending: string | null = null

/** Set while a key is being recorded: no command runs then. */
export const shortcutRecording = { on: false }

export { keyLabel } from './keybindings'

export function onGlobalKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || shortcutRecording.on) return
  // a key the input method is using to compose a word (Unikey, Telex…)
  if (e.isComposing || e.keyCode === 229) return
  const press = pressOf(e)
  if (!press) return
  const r = resolve(bindings, press, pending, context())
  pending = null
  if (r.kind === 'none') return
  if (r.kind === 'run' && r.command === 'passToTerminal') return
  e.preventDefault()
  e.stopPropagation()
  if (r.kind === 'chord') pending = r.first
  else if (r.kind === 'run') byId.get(r.command)?.run()
}

// the defaults are in force before the first key press; the user's file is read at boot
apply(null)
