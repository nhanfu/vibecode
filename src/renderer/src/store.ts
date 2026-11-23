import { create } from 'zustand'
import type { AgentId } from '../../shared/agents'
import type { AgentInfo, AppSettings, ClaudeInfo, GitState, PluginInfo, ProjectGroup, WindowState } from '../../shared/types'
import { userStore } from './localPref'

export type ChatStatus = 'starting' | 'working' | 'idle' | 'exited'

export interface Chat {
  id: string
  title: string
  /** true once the user renamed it — stop following the terminal title */
  pinnedTitle: boolean
  cwd: string
  status: ChatStatus
  /** finished work while you were looking elsewhere */
  attention: boolean
  createdAt: number
  /** coding agent this chat runs — undefined = Claude Code */
  agent?: AgentId
  claudeArgs?: string[]
  /** Claude Code session id — links this chat to its entry in ~/.claude/projects */
  sessionId?: string
  model?: string
  effort?: string
  permissionMode?: string
}

export interface ShellTab {
  id: string
  title: string
  cwd: string
  exited: boolean
}

export type EditorTab =
  | { id: string; kind: 'file'; path: string; title: string; dirty: boolean }
  /** commit set: that commit vs its parent; otherwise working tree vs HEAD */
  | { id: string; kind: 'diff'; path: string; rel: string; title: string; commit?: { hash: string; short: string; subject: string } }

/** What to show in a plugin's page next (the VS Code panel: a file, or two files side by side). `n` makes a repeat count. */
export interface PluginOpen {
  n: number
  file?: string
  /** `left` is the older version, `right` the one being edited */
  diff?: { left: string; right: string }
}

export type SidebarView = 'chats' | 'explorer' | 'changes'

interface State {
  root: string | null
  recent: string[]
  claude: ClaudeInfo | null
  /** which coding agents (Claude, Codex, Grok…) are installed */
  agents: AgentInfo[]
  /** plugins found on this machine (plugins/<id>/plugin.json) */
  plugins: PluginInfo[]
  /** files and diffs to show in a plugin's page (by plugin id), see actions.ts `review` */
  pluginOpen: Record<string, PluginOpen>
  /** AI picked as "in use" — a plain New chat starts with it */
  preferredAgent: AgentId | null
  git: GitState
  fsTick: number
  /** every project + session Claude Code knows about (shared with the Claude app) */
  projects: ProjectGroup[]
  win: WindowState | null
  settings: AppSettings | null
  /** theme actually showing (system preference resolved) */
  themeResolved: 'light' | 'dark' | 'blue'

  sidebarView: SidebarView
  /** the title-bar drop-downs, left to right; pinned ones sit side by side in this order (saved) */
  panelOrder: PanelId[]
  /** drop-downs pinned into the horizontal stack, beside the chat (saved) */
  pinned: PanelId[]
  /** the drop-down floating open from a click or its key, until a click elsewhere (not pinned) */
  floatOpen: PanelId | null
  /** the drop-down floating while the pointer is on its button or on it (wins over floatOpen) */
  peek: PanelId | null
  bottomOpen: boolean
  quickOpen: boolean
  /** what the palette starts with: '' files, '>' commands (Ctrl+Shift+P) */
  quickOpenQuery: string

  chats: Chat[]
  activeChatId: string | null

  shells: ShellTab[]
  activeShellId: string | null

  tabs: EditorTab[]
  activeTabId: string | null
  diffSideBySide: boolean

  /** each chat has its own browser tabs: chat id ('_' with no chat open) → its tabs */
  browsers: Record<string, ChatBrowser>
  /** project folder (lower-cased, no trailing slash) → Claude runs it in bypass-permissions mode */
  projectBypass: Record<string, boolean>
  /** the Browser mini-app: one set of tabs for all chats (true) or one set per chat (false) */
  browserShared: boolean

  set: (p: Partial<State>) => void
  patchChat: (id: string, p: Partial<Chat>) => void
  patchShell: (id: string, p: Partial<ShellTab>) => void
}

/** One tab of the built-in browser. */
export interface WebTab {
  id: string
  url: string
  title: string
  /** torn off into its own title-bar button (panel `page:<id>`); not in the Web tab strip */
  detached?: boolean
  pinned?: boolean
  muted?: boolean
  /** the chat a tab belongs to while the Browser is shared by all chats (it goes back there when split again) */
  home?: string
}
export interface ChatBrowser {
  tabs: WebTab[]
  active: string
}

/**
 * The title-bar drop-downs: Project (chats), Source code, Web, Database and Agent (the chat with the
 * agent you are talking to). Each one floats while hovered or opened (a click, its key); a
 * double-click pins it into the horizontal stack, where it stays. Dragging the buttons reorders the
 * stack. Agent starts pinned, so the chat is on screen.
 */
export type StaticPanelId = 'project' | 'web' | 'db' | 'plugins' | 'agents'
/** A web tab torn off the Web drop-down: its own button and panel, for as long as the tab lives. */
export type PagePanelId = `page:${string}`
/** A plugin's own panel (its manifest's `panel`): `plugin:<id>`. Shown while the plugin is on and can run. */
export type PluginPanelId = `plugin:${string}`
export type PanelId = StaticPanelId | PagePanelId | PluginPanelId
export const PANEL_IDS: StaticPanelId[] = ['project', 'web', 'db', 'plugins', 'agents']
export const isPage = (id: PanelId): id is PagePanelId => id.startsWith('page:')
export const isPluginPanel = (id: PanelId): id is PluginPanelId => id.startsWith('plugin:')
export const pluginPanelId = (plugin: string): PluginPanelId => `plugin:${plugin}`
/** The plugins that get a title-bar panel of their own: on, able to run, with a page, and not taking over a built-in panel. */
export const panelPlugins = (plugins: PluginInfo[]): PluginInfo[] => plugins.filter((p) => p.enabled && p.available && p.hasSidecar && p.panel && !p.panel.replaces)
export const pageTabId = (id: PagePanelId): string => id.slice(5)
/** The torn-off tab behind a page panel, with the browser key (chat) it belongs to. */
export function pageTab(s: Pick<State, 'browsers'>, id: PagePanelId): WebTab | undefined {
  const tid = pageTabId(id)
  for (const b of Object.values(s.browsers)) {
    const t = b.tabs.find((x) => x.id === tid)
    if (t) return t
  }
  return undefined
}
export function pageKey(s: Pick<State, 'browsers'>, id: PagePanelId): string | undefined {
  const tid = pageTabId(id)
  return Object.keys(s.browsers).find((k) => s.browsers[k].tabs.some((t) => t.id === tid))
}

const ORDER_KEY = 'vibe.panelOrder'
// (a new key: pins saved before Agent became the chat would leave the chat floating)
const PINNED_KEY = 'vibe.stackPins'

/** Browser key that holds the torn-off pages restored from a previous run (they belong to no chat). */
export const PAGES_KEY = '_pages'
export const SHARED_BROWSER_KEY = '_shared'
const BROWSER_SHARED_STORE = 'vibe.browserShared'
const PAGES_STORE = 'vibe.pages'
interface SavedTab {
  id: string
  url: string
  title: string
  chat?: string
  home?: string
  detached?: boolean
  pinned?: boolean
  muted?: boolean
}
/** The Web tabs kept as user data: each chat's tabs and the torn-off pages, with address, title and state. */
const savedTabs: SavedTab[] = (() => {
  try {
    const v = JSON.parse(userStore.getItem(PAGES_STORE) ?? 'null')
    if (Array.isArray(v))
      return v
        .filter((t) => t && typeof t.id === 'string' && typeof t.url === 'string')
        .map((t) => ({ id: t.id, url: t.url, title: String(t.title ?? ''), chat: typeof t.chat === 'string' ? t.chat : undefined, detached: !!t.detached, pinned: !!t.pinned, muted: !!t.muted, home: typeof t.home === 'string' ? t.home : undefined }))
  } catch {
    /* storage unavailable */
  }
  return []
})()
const savedBrowsers: Record<string, ChatBrowser> = {}
for (const t of savedTabs) {
  const key = t.chat ?? PAGES_KEY
  const tab: WebTab = { id: t.id, url: t.url, title: t.title, ...(t.detached ? { detached: true } : {}), ...(t.pinned ? { pinned: true } : {}), ...(t.muted ? { muted: true } : {}), ...(t.home ? { home: t.home } : {}) }
  const b = savedBrowsers[key] ?? { tabs: [], active: tab.id }
  b.tabs.push(tab)
  savedBrowsers[key] = b
}
const isSavedPage = (x: unknown): boolean => typeof x === 'string' && savedTabs.some((t) => t.detached && `page:${t.id}` === x)

function loadIds(key: string, fallback: PanelId[]): PanelId[] {
  try {
    const v = JSON.parse(userStore.getItem(key) ?? 'null')
    if (Array.isArray(v)) return [...new Set(v.filter((x): x is PanelId => (PANEL_IDS as string[]).includes(x) || isSavedPage(x) || (typeof x === 'string' && x.startsWith('plugin:'))))]
  } catch {
    /* storage unavailable */
  }
  return fallback
}
function saveIds(key: string, ids: PanelId[]): void {
  try {
    userStore.setItem(key, JSON.stringify(ids))
  } catch {
    /* back to the default next time */
  }
}
/** The saved order, with drop-downs added since appended. */
function loadOrder(): PanelId[] {
  const saved = loadIds(ORDER_KEY, PANEL_IDS)
  return [...saved, ...PANEL_IDS.filter((p) => !saved.includes(p))]
}

type PanelState = Pick<State, 'pinned' | 'floatOpen' | 'peek'>
/** The drop-down floating now, if any (hovered wins over opened). */
export const floating = (s: PanelState): PanelId | null => {
  const f = s.peek ?? s.floatOpen
  return f && !s.pinned.includes(f) ? f : null
}
/** On screen: pinned in the stack, or floating. */
export const panelShown = (s: PanelState, id: PanelId): boolean => s.pinned.includes(id) || floating(s) === id

/** State that shows a drop-down: nothing to do when it is pinned, else it floats open. For set() patches. */
export function openPatch(id: PanelId): Partial<State> {
  const s = useStore.getState()
  return s.pinned.includes(id) ? {} : { floatOpen: id, peek: null }
}

let peekTimer: number | undefined
const stopPeekTimer = (): void => {
  window.clearTimeout(peekTimer)
  peekTimer = undefined
}

/**
 * Hovering a drop-down's button (or the drop-down) shows it, and keeps it shown. A pinned one's
 * button is already on screen: the one floating from hovering hides, as when leaving it.
 */
export function peekPanel(id: PanelId): void {
  const s = useStore.getState()
  if (s.pinned.includes(id)) return leavePanel()
  stopPeekTimer()
  if (s.peek !== id) useStore.setState({ peek: id })
}

/** The pointer is on the rest of the app: the hovered drop-down hides after a moment (so it can cross a gap). */
export function leavePanel(): void {
  if (peekTimer !== undefined || useStore.getState().peek === null) return
  peekTimer = window.setTimeout(() => {
    peekTimer = undefined
    useStore.setState({ peek: null })
  }, 200)
}

/** Show a drop-down: float it open, or (pinned) leave it where it is. */
export function showPanel(id: PanelId): void {
  stopPeekTimer()
  useStore.setState(openPatch(id))
}

/** Hide whatever floats (pinned ones stay). */
export function closeFloat(): void {
  stopPeekTimer()
  const s = useStore.getState()
  if (s.floatOpen !== null || s.peek !== null) useStore.setState({ floatOpen: null, peek: null })
}

/**
 * A drop-down's key or click: float it open, or close it when it is the one open. A pinned one is
 * already on screen; the cursor goes into it instead.
 */
export function togglePanel(id: PanelId): void {
  const s = useStore.getState()
  if (s.pinned.includes(id)) return focusPanel(id)
  if (floating(s) === id) closeFloat()
  else showPanel(id)
}

/** The cursor into a drop-down: its first text box, else anything that takes focus. */
export function focusPanel(id: PanelId): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.stack-panel[data-panel="${id}"]`)
    const target = el?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, [tabindex="0"], button')
    target?.focus()
  })
}

/** Double-click on a drop-down's button: pin it into the stack, or back to floating. */
export function togglePin(id: PanelId): void {
  stopPeekTimer()
  const s = useStore.getState()
  const pinned = s.pinned.includes(id) ? s.pinned.filter((p) => p !== id) : [...s.pinned, id]
  saveIds(PINNED_KEY, pinned)
  useStore.setState({ pinned, floatOpen: null, peek: null })
}

/**
 * Keeps the plugin panels in step with the plugins: one appears (at the end) when its plugin can
 * run, and one goes when it is turned off, removed or cannot run. Kept in the saved order.
 */
export function syncPluginPanels(plugins: PluginInfo[]): void {
  const s = useStore.getState()
  const want = panelPlugins(plugins).map((p) => pluginPanelId(p.id))
  const order = s.panelOrder.filter((id) => !isPluginPanel(id) || want.includes(id))
  const next = [...order, ...want.filter((id) => !order.includes(id))]
  const pinned = s.pinned.filter((id) => !isPluginPanel(id) || want.includes(id))
  const floatOpen = s.floatOpen && isPluginPanel(s.floatOpen) && !want.includes(s.floatOpen) ? null : s.floatOpen
  if (next.join() === s.panelOrder.join() && pinned.length === s.pinned.length && floatOpen === s.floatOpen) return
  saveIds(ORDER_KEY, next)
  saveIds(PINNED_KEY, pinned)
  useStore.setState({ panelOrder: next, pinned, floatOpen })
}

/** Drag a drop-down's button to `index` (in the order before the move). */
export function movePanel(id: PanelId, index: number): void {
  const order = useStore.getState().panelOrder.filter((p) => p !== id)
  const at = Math.max(0, Math.min(order.length, index))
  order.splice(at, 0, id)
  saveIds(ORDER_KEY, order)
  useStore.setState({ panelOrder: order })
}

export const useStore = create<State>((set) => ({
  root: null,
  recent: [],
  claude: null,
  agents: [],
  plugins: [],
  pluginOpen: {},
  preferredAgent: (() => {
    try {
      return (userStore.getItem('vibe.newChatAgent') as AgentId | null) ?? null
    } catch {
      return null
    }
  })(),
  git: { isRepo: false, root: null, branch: null, files: [] },
  fsTick: 0,
  projects: [],
  win: null,
  settings: null,
  themeResolved: 'dark',

  sidebarView: 'chats',
  panelOrder: loadOrder(),
  pinned: loadIds(PINNED_KEY, ['agents']),
  floatOpen: null,
  peek: null,
  bottomOpen: false,
  quickOpen: false,
  quickOpenQuery: '',

  chats: [],
  activeChatId: null,

  shells: [],
  activeShellId: null,

  tabs: [],
  activeTabId: null,
  diffSideBySide: true,

  browsers: savedBrowsers,
  projectBypass: {},
  browserShared: userStore.getItem(BROWSER_SHARED_STORE) === 'true',

  set: (p) => set(p),
  // a patch that changes nothing keeps the same array: the terminal title (Claude's spinner) and
  // status checks patch many times a second, and each new array re-rendered every chat list
  patchChat: (id, p) =>
    set((s) => {
      const c = s.chats.find((x) => x.id === id)
      if (!c || (Object.keys(p) as (keyof Chat)[]).every((k) => c[k] === p[k])) return s
      return { chats: s.chats.map((x) => (x.id === id ? { ...x, ...p } : x)) }
    }),
  patchShell: (id, p) =>
    set((s) => {
      const c = s.shells.find((x) => x.id === id)
      if (!c || (Object.keys(p) as (keyof ShellTab)[]).every((k) => c[k] === p[k])) return s
      return { shells: s.shells.map((x) => (x.id === id ? { ...x, ...p } : x)) }
    })
}))

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export const fileUri = (p: string): string => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '')

// keep the Web tabs (address, title and state) as user data; the blank ones are not worth keeping
const serializeTabs = (browsers: Record<string, ChatBrowser>): string =>
  JSON.stringify(
    Object.entries(browsers).flatMap(([key, b]) =>
      b.tabs
        .filter((t) => t.url !== 'about:blank' || t.detached || t.pinned || t.muted)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, chat: key, ...(t.detached ? { detached: true } : {}), ...(t.pinned ? { pinned: true } : {}), ...(t.muted ? { muted: true } : {}), ...(t.home ? { home: t.home } : {}) }))
    )
  )
let savedJson = serializeTabs(savedBrowsers)
useStore.subscribe((s, prev) => {
  if (s.browsers === prev.browsers) return
  const json = serializeTabs(s.browsers)
  if (json === savedJson) return
  savedJson = json
  try {
    userStore.setItem(PAGES_STORE, json)
  } catch {
    /* only lost on the next run */
  }
})

/** Remembers whether the Browser mini-app shares one set of tabs among all chats. */
export function saveBrowserShared(shared: boolean): void {
  try {
    userStore.setItem(BROWSER_SHARED_STORE, String(shared))
  } catch {
    /* only lost on the next run */
  }
}
