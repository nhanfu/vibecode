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
import { closeFloat, floating, focusPanel, isPage, PANEL_IDS, pageTab, panelShown, showPanel, toggleFullscreen, togglePanel, togglePin, useStore, type PanelId, type StaticPanelId, type WebTab } from './store'
import {
  browserKey,
  closeBrowserTab,
  closeChat,
  closeTab,
  cycleChat,
  cycleAgent,
  cycleAgentGroup,
  cycleWebTab,
  defaultAgent,
  duplicateChat,
  pageLabels,
  stepBrowserHistory,
  newChat,
  newShell,
  newWebTab,
  openBrowser,
  openFolder,
  openFile,
  reopenClosedWebTab,
  selectChat,
  toggleBottom,
  toggleTheme
} from './actions'
import { focusTerm } from './terminals'
import { saveFile } from './fileModelsLite'
import type { PluginInfo } from '../../shared/types'
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

/** Files and Git changes are groups of the agent sidebar: show the chat's panel, open the group. */
const revealSide = (group: 'files' | 'git-changes'): void => {
  showPanel('agents')
  window.dispatchEvent(new CustomEvent('side-group-reveal', { detail: group }))
}
const palette = (query: string): void => useStore.setState({ quickOpen: true, quickOpenQuery: query })
const PANEL_LABELS: Record<StaticPanelId, string> = { project: 'Project', web: 'Web', db: 'Database', plugins: 'Plugins', agents: 'Agent (chat)' }

/** One command per plugin that has a settings file: opens it in the editor to edit and review. */
export function pluginCommands(plugins: PluginInfo[]): Command[] {
  return plugins
    .filter((p) => p.hasSettings && p.enabled)
    .map((p) => ({
      id: `plugin.settings.${p.id}`,
      label: `${p.name}: Open settings.json`,
      run: () => {
        window.api.plugins.settingsFile(p.id).then(
          (file) => openFile(file),
          (e) => window.alert(String(e))
        )
      }
    }))
}

export const COMMANDS: Command[] = [
  { id: 'palette', label: 'Show all commands', run: () => palette('>') },
  { id: 'quickOpen', label: 'Go to file…', run: () => st().root && palette('') },
  { id: 'symbol', label: 'Go to symbol in file…', run: () => window.dispatchEvent(new Event('go-to-symbol')) },
  { id: 'line', label: 'Go to line…', run: () => window.dispatchEvent(new Event('go-to-line')) },
  { id: 'reloadApp', label: 'Reload app', run: () => window.location.reload() },
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
  { id: 'closeTab', label: 'Close the file or change on show', run: () => closeActiveTab() },
  { id: 'newWebTab', label: 'New web tab', run: () => newWebTab() },
  {
    id: 'closeWebTab',
    label: 'Close web tab',
    run: () => {
      const key = browserKey(st().activeChatId)
      const active = st().browsers[key]?.active
      if (active) closeBrowserTab(key, active)
    }
  },
  { id: 'reopenWebTab', label: 'Reopen closed web tab', run: () => reopenClosedWebTab() },
  { id: 'nextWebTab', label: 'Next web tab', run: () => cycleWebTab(1) },
  { id: 'prevWebTab', label: 'Previous web tab', run: () => cycleWebTab(-1) },
  { id: 'nextAgent', label: 'Next running agent', run: () => cycleAgent(1) },
  { id: 'prevAgent', label: 'Previous running agent', run: () => cycleAgent(-1) },
  { id: 'nextAgentGroup', label: 'Next agent group', run: () => cycleAgentGroup(1) },
  { id: 'prevAgentGroup', label: 'Previous agent group', run: () => cycleAgentGroup(-1) },
  { id: 'duplicateAgent', label: 'Duplicate agent beside this one', run: () => duplicateChat() },
  { id: 'fullscreen', label: 'Mini-app full screen', run: () => toggleFullscreen(currentMiniApp()) },
  { id: 'miniAppPrev', label: 'Previous mini-app', run: () => cycleMiniApp(-1) },
  { id: 'miniAppNext', label: 'Next mini-app', run: () => cycleMiniApp(1) },
  { id: 'webBack', label: 'Back in the web tab', run: () => stepBrowserHistory(-1) },
  { id: 'webForward', label: 'Forward in the web tab', run: () => stepBrowserHistory(1) },

  { id: 'explorer', label: 'Show Explorer (files)', run: () => revealSide('files') },
  { id: 'changes', label: 'Show Source Control (changes)', run: () => revealSide('git-changes') },
  {
    id: 'chats',
    label: 'Show chats (Project)',
    run: () => {
      useStore.setState({ sidebarView: 'chats' })
      showPanel('project')
    }
  },
  { id: 'terminal', label: 'Toggle terminal', run: () => toggleBottom() },
  { id: 'panel', label: 'Toggle bottom panel', run: () => toggleBottom() },
  { id: 'newTerminal', label: 'New terminal', run: () => newShell() },

  // the title-bar drop-downs: float open / close; pinned ones get the cursor instead (store.ts togglePanel)
  { id: 'sidebar', label: 'Show / hide Project (chats and folders)', run: () => togglePanel('project') },
  {
    id: 'viewWeb',
    label: 'Show / hide Web',
    // openBrowser also gives the chat its first page
    run: () => (panelShown(st(), 'web') ? togglePanel('web') : openBrowser())
  },
  { id: 'viewDb', label: 'Show / hide Database', run: () => togglePanel('db') },
  { id: 'viewPlugins', label: 'Show / hide Plugins', run: () => togglePanel('plugins') },
  // the chat: showing it puts the cursor in it, so you can type straight away
  { id: 'viewAgents', label: 'Show / hide Agent (the chat)', run: () => toggleChatPanel() },
  ...PANEL_IDS.map((id) => ({ id: `pin.${id}`, label: `Pin / unpin ${PANEL_LABELS[id]} in the stack`, run: () => togglePin(id) })),
  { id: 'closeFloat', label: 'Close the floating drop-down', run: () => closeFloat() },

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

/** The cursor into the open chat, bringing the Agent drop-down up when it floats. */
function focusActiveChat(): void {
  const id = st().activeChatId
  if (!id) return
  showPanel('agents')
  focusTerm(id)
}

/** Agent's key: pinned or opening, the cursor goes into the chat; floating open, it closes. */
function toggleChatPanel(): void {
  const s = st()
  if (!s.pinned.includes('agents') && floating(s) === 'agents') return closeFloat()
  focusActiveChat()
}

function saveActive(): void {
  const f = activeFile()
  if (f) void saveFile(f.path)
}

function closeActiveTab(): void {
  const id = st().tabs[0]?.id
  if (id) closeTab(id)
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
  { key: 'alt+shift+down', command: 'nextAgent' },
  { key: 'alt+shift+up', command: 'prevAgent' },
  { key: 'alt+down', command: 'nextAgentGroup' },
  { key: 'alt+up', command: 'prevAgentGroup' },
  { key: 'alt+shift+d', command: 'duplicateAgent' },
  { key: 'alt+enter', command: 'fullscreen' },
  { key: 'alt+shift+left', command: 'miniAppPrev' },
  { key: 'alt+shift+right', command: 'miniAppNext' },
  { key: 'ctrl+shift+l', command: 'focusChat' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: `alt+${n}`, command: `chat${n}` })),

  // nothing unsaved: the key is left alone
  { key: 'ctrl+s', command: 'save', when: '!terminalFocus && fileDirty' },
  { key: 'ctrl+w', command: 'closeTab', when: '!terminalFocus && !textInputFocus && reviewOpen' },
  { key: 'ctrl+f4', command: 'closeTab', when: '!terminalFocus && reviewOpen' },
  // the keyboard in a Web tab: these keys belong to the tabs there (the later rule wins)
  { key: 'ctrl+t', command: 'newWebTab', when: '!terminalFocus' },
  { key: 'ctrl+w', command: 'closeWebTab', when: 'webFocus' },
  { key: 'ctrl+shift+t', command: 'reopenWebTab', when: '!terminalFocus' },
  { key: 'ctrl+tab', command: 'nextWebTab', when: '!terminalFocus' },
  { key: 'ctrl+shift+tab', command: 'prevWebTab', when: '!terminalFocus' },
  { key: 'alt+left', command: 'webBack', when: '!terminalFocus' },
  { key: 'alt+right', command: 'webForward', when: '!terminalFocus' },

  { key: 'ctrl+shift+e', command: 'explorer' },
  { key: 'ctrl+shift+g', command: 'changes' },
  // Ctrl+Shift+C in a terminal copies (Windows Terminal / VS Code)
  { key: 'ctrl+shift+c', command: 'chats', when: '!terminalFocus' },
  { key: 'ctrl+b', command: 'sidebar' },
  { key: 'ctrl+`', command: 'terminal' },
  { key: 'ctrl+j', command: 'panel', when: '!terminalFocus && !textInputFocus' },
  { key: 'ctrl+shift+`', command: 'newTerminal' },

  // the title-bar drop-downs (Ctrl+B: Project, above), from a terminal too
  { key: 'ctrl+shift+w', command: 'viewWeb' },
  { key: 'ctrl+shift+d', command: 'viewDb' },
  { key: 'ctrl+shift+a', command: 'viewAgents' },
  { key: 'ctrl+shift+x', command: 'viewPlugins' },
  { key: 'ctrl+2', command: 'viewWeb' },
  { key: 'ctrl+3', command: 'viewDb' },
  { key: 'ctrl+4', command: 'viewAgents' }
]

const activeWebTab = (): WebTab | undefined => {
  const s = st()
  const b = s.browsers[browserKey(s.activeChatId)]
  return b?.tabs.find((t) => t.id === b.active)
}

export function currentMiniApp(): PanelId {
  const s = st()
  if (s.fullscreen) return s.fullscreen
  const floated = floating(s)
  if (floated) return floated
  if (webHasFocus) {
    const tab = activeWebTab()
    return tab?.detached ? `page:${tab.id}` : 'web'
  }
  const here = (document.activeElement as HTMLElement | null)?.closest?.('.stack-panel')?.getAttribute('data-panel')
  if (here) return here as PanelId
  return s.pinned.includes('agents') ? 'agents' : ([...s.panelOrder].reverse().find((p) => s.pinned.includes(p)) ?? 'agents')
}

function focusMiniApp(id: PanelId): void {
  window.api.browser.focusMain()
  const s = st()
  if (id === 'web' || isPage(id)) {
    const tab = isPage(id) ? pageTab(s, id) : activeWebTab()
    const label = tab ? pageLabels.get(tab.id) : undefined
    if (label) window.api.browser.focus(label)
    return
  }
  if (id === 'agents' && s.activeChatId) return focusTerm(s.activeChatId)
  focusPanel(id)
}

export function cycleMiniApp(step: 1 | -1): void {
  const s = st()
  const list = s.panelOrder.filter((id) => !isPage(id) || !!pageTab(s, id))
  if (!list.length) return
  const i = list.indexOf(currentMiniApp())
  const next = list[(i < 0 ? 0 : i + step + list.length) % list.length]
  webHasFocus = false
  if (s.fullscreen) useStore.setState({ fullscreen: next, floatOpen: null, peek: null })
  else if (!s.pinned.includes(next)) showPanel(next)
  focusMiniApp(next)
}

export function runNativeShortcut(id: string): void {
  webHasFocus = true
  byId.get(id)?.run()
}

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
    webFocus: webHasFocus || !!el?.closest?.('.browser-tab'),
    terminalFocus: !!term,
    chatFocus: !!term && term.dataset.kind === 'claude',
    shellFocus: !!term && term.dataset.kind === 'shell',
    editorFocus: editor,
    textInputFocus: field,
    inputFocus: editor || field,
    hasFolder: !!s.root,
    fileDirty: !!activeFile()?.dirty,
    reviewOpen: s.tabs.length > 0,
    floating: floating(s) ?? '',
    ...Object.fromEntries(PANEL_IDS.flatMap((id) => [[`${id}Shown`, panelShown(s, id)], [`${id}Pinned`, s.pinned.includes(id)]]))
  }
}
const CONTEXT_HELP = [
  'webFocus           the keyboard is in a Web tab (its address bar or its page)',
  'terminalFocus      the cursor is in a terminal (a chat or a shell)',
  'chatFocus          … in a chat (Claude Code or another coding agent)',
  'shellFocus         … in a shell terminal',
  'editorFocus        … in the code editor',
  'textInputFocus     … in a text box (address bar, search, filter…)',
  'inputFocus         editorFocus || textInputFocus',
  'hasFolder          a project folder is open',
  'fileDirty          the open file has unsaved changes',
  'reviewOpen         a file or a change is open in the popup',
  "floating           the drop-down floating now: 'project' | 'web' | 'db' | 'plugins' | 'agents', '' if none",
  'projectShown webShown dbShown pluginsShown agentsShown        that drop-down is on screen (pinned or floating)',
  'projectPinned webPinned dbPinned pluginsPinned agentsPinned   … pinned in the stack'
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

/** The page (a native view, outside the document) has the keyboard: set when its keys arrive, cleared by a click elsewhere. */
let webHasFocus = false
document.addEventListener('pointerdown', (e) => {
  webHasFocus = !!(e.target as HTMLElement | null)?.closest?.('.browser-tab')
}, true)

/** Ctrl+T / Ctrl+W / Ctrl+Shift+T pressed in a Web page: run them as if they came from the window. */
export function webKeyFromNative(key: string, shift: boolean): void {
  webHasFocus = true
  window.dispatchEvent(new KeyboardEvent('keydown', { key: shift ? key.toUpperCase() : key, ctrlKey: true, shiftKey: shift }))
}

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
