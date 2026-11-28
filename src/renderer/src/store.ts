import { create } from 'zustand'
import type { AppSettings, PluginInfo, WindowState } from '../../shared/types'
import { userStore } from './localPref'

interface State {
  /** plugins found on this machine (plugins/<id>/plugin.json) */
  plugins: PluginInfo[]
  win: WindowState | null
  settings: AppSettings | null
  /** theme actually showing (system preference resolved) */
  themeResolved: 'light' | 'dark' | 'blue'
  /** the title-bar drop-downs, left to right; pinned ones sit side by side in this order (saved) */
  panelOrder: PanelId[]
  /** drop-downs pinned into the horizontal stack (saved) */
  pinned: PanelId[]
  /** the drop-down floating open from a click or its key, until a click elsewhere (not pinned) */
  floatOpen: PanelId | null
  /** the drop-down floating while the pointer is on its button or on it (wins over floatOpen) */
  peek: PanelId | null
  fullscreen: PanelId | null
  set: (p: Partial<State>) => void
}

/**
 * The title-bar drop-downs: Plugins, and each plugin's own panel. Each one floats while hovered or
 * opened (a click, its key); a double-click pins it into the horizontal stack, where it stays.
 * Dragging the buttons reorders the stack.
 */
export type StaticPanelId = 'plugins' | 'terminal'
/** A plugin's own panel (its manifest's `panel`): `plugin:<id>`. Shown while the plugin is on and its service runs. */
export type PluginPanelId = `plugin:${string}`
export type PanelId = StaticPanelId | PluginPanelId
export const PANEL_IDS: StaticPanelId[] = ['plugins', 'terminal']
export const isPluginPanel = (id: PanelId): id is PluginPanelId => id.startsWith('plugin:')
export const pluginPanelId = (plugin: string): PluginPanelId => `plugin:${plugin}`
/** The plugins that get a title-bar panel of their own: on, able to run, with a page, and not taking over a built-in panel. */
export const panelPlugins = (plugins: PluginInfo[]): PluginInfo[] => plugins.filter((p) => p.enabled && p.available && p.hasSidecar && p.panel)
/** Its service runs (or is starting): the one state in which its title-bar panel stays. */
export const serviceLive = (p: PluginInfo): boolean => p.status === 'running' || p.status === 'starting'

const ORDER_KEY = 'vibe.panelOrder'
const PINNED_KEY = 'vibe.stackPins'

function loadIds(key: string, fallback: PanelId[]): PanelId[] {
  try {
    const v = JSON.parse(userStore.getItem(key) ?? 'null')
    if (Array.isArray(v)) return [...new Set(v.filter((x): x is PanelId => (PANEL_IDS as string[]).includes(x) || (typeof x === 'string' && x.startsWith('plugin:'))))]
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

type PanelState = Pick<State, 'pinned' | 'floatOpen' | 'peek' | 'fullscreen'>
/** The drop-down floating now, if any (hovered wins over opened). */
export const floating = (s: PanelState): PanelId | null => {
  const f = s.peek ?? s.floatOpen
  return f && !s.pinned.includes(f) ? f : null
}
/** On screen: pinned in the stack, or floating. */
export const panelShown = (s: PanelState, id: PanelId): boolean =>
  s.fullscreen ? s.fullscreen === id : s.pinned.includes(id) || floating(s) === id

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
  const s = useStore.getState()
  if (isPluginPanel(id) && !s.panelOrder.includes(id)) {
    const order = [...s.panelOrder, id]
    saveIds(ORDER_KEY, order)
    useStore.setState({ panelOrder: order })
  }
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

export function toggleFullscreen(id: PanelId): void {
  if (useStore.getState().fullscreen) return useStore.setState({ fullscreen: null })
  useStore.setState({ fullscreen: id, floatOpen: null, peek: null })
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
  plugins: [],
  win: null,
  settings: null,
  themeResolved: 'dark',
  panelOrder: loadOrder(),
  pinned: loadIds(PINNED_KEY, ['terminal']),
  floatOpen: null,
  peek: null,
  fullscreen: null,
  set: (p) => set(p)
}))

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
