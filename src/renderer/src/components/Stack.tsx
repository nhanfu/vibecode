import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Bot, Clock, Code2, Database, FolderOpen, Globe, MoveHorizontal, PanelTop, Pin, PinOff, Puzzle, X } from 'lucide-react'
import {
  basename,
  closeFloat,
  floating,
  isPage,
  leavePanel,
  movePanel,
  PANEL_IDS,
  pageKey,
  pageTab,
  peekPanel,
  showPanel,
  togglePanel,
  togglePin,
  useStore,
  type PanelId,
  type StaticPanelId
} from '../store'
import { attachBrowserTab, browserKey, closeAllBrowserTabs, closeBrowserTab, openFolder } from '../actions'
import { SiteIcon } from './SiteIcon'
import { Adopt, TabHosts } from './webHosts'
import { COMMANDS } from '../shortcuts'
import { Sidebar } from './Sidebar'
import { CodePanel, DbPanel, WebPanel } from './Editor'
import { agentDef } from '../../../shared/agents'
import { AgentSplit } from './Agents'
import { PluginManager } from './PluginManager'
import { userStore } from '../localPref'

/*
 * The title-bar drop-downs as a horizontal stack (store.ts PanelId). A drop-down floats under its
 * button while hovered, or opened by a click / its key until a click elsewhere; a double-click on
 * the button pins it into the stack, and another unpins it. Right-click on a button has the same
 * and more (move, reset width), like a tab in Chrome. Dragging the buttons sideways reorders the
 * stack.
 */

interface PanelMeta {
  label: string
  icon: typeof Code2
  /** the command that shows it (its key is shown in the tooltip) */
  command: string
  size: FloatSize
}

interface FloatSize {
  /** key in the saved preferences */
  key: string
  /** width before it is ever dragged, and after a double-click on the edge */
  initial: () => number
  min: number
}

const PANELS: Record<StaticPanelId, PanelMeta> = {
  project: { label: 'Project', icon: FolderOpen, command: 'sidebar', size: { key: 'vibe.sidebarWidth', initial: () => 300, min: 220 } },
  code: { label: 'Source code', icon: Code2, command: 'viewCode', size: { key: 'vibe.centerWidth', initial: () => Math.round(window.innerWidth * 0.55), min: 360 } },
  web: { label: 'Web', icon: Globe, command: 'viewWeb', size: { key: 'vibe.webWidth', initial: () => Math.round(window.innerWidth * 0.5), min: 320 } },
  db: { label: 'Database', icon: Database, command: 'viewDb', size: { key: 'vibe.dbWidth', initial: () => Math.round(window.innerWidth * 0.5), min: 360 } },
  plugins: { label: 'Plugins', icon: Puzzle, command: 'viewPlugins', size: { key: 'vibe.pluginsWidth', initial: () => Math.round(window.innerWidth * 0.4), min: 340 } },
  agents: { label: 'Agent', icon: Bot, command: 'viewAgents', size: { key: 'vibe.agentWidth', initial: () => Math.round(window.innerWidth * 0.45), min: 320 } }
}

/** A torn-off web tab: titled after its page, its own width. */
const PAGE_META: PanelMeta = { label: 'Page', icon: Globe, command: '', size: { key: 'vibe.pageWidth', initial: () => Math.round(window.innerWidth * 0.45), min: 320 } }
const metaOf = (id: PanelId): PanelMeta => (isPage(id) ? PAGE_META : PANELS[id])

const keysOf = (id: PanelId): string | undefined => (isPage(id) ? undefined : COMMANDS.find((c) => c.id === PANELS[id].command)?.keys)

/* ---------------- title bar ---------------- */

/** Pixels the pointer moves before a press on a button becomes a drag. */
const DRAG_START = 5
/** A click waits this long for a second one (a double-click pins instead). */
const CLICK_WAIT = 220

export function StackBar(): React.JSX.Element {
  const order = useStore((s) => s.panelOrder)
  const barRef = useRef<HTMLDivElement>(null)
  // the button being dragged, and where it would land (index in the order without it)
  const [drag, setDrag] = useState<{ id: PanelId; to: number } | null>(null)

  /** Where a button dropped at `x` lands: before the first other button whose middle is right of x. */
  const dropIndex = (id: PanelId, x: number): number => {
    const others = [...(barRef.current?.querySelectorAll<HTMLElement>('.stack-btn') ?? [])].filter((b) => b.dataset.panel !== id)
    const i = others.findIndex((b) => {
      const r = b.getBoundingClientRect()
      return x < r.left + r.width / 2
    })
    return i < 0 ? others.length : i
  }

  return (
    <div className={`stack-bar${drag ? ' dragging' : ''}`} ref={barRef} onMouseDown={(e) => e.stopPropagation()}>
      {order.map((id) => {
        const without = order.filter((p) => p !== id)
        // the drop mark goes before the button that will follow the dragged one
        const markBefore = drag && drag.id !== id && without[drag.to] === id
        const markAfter = drag && drag.id !== id && drag.to === without.length && without[without.length - 1] === id
        return (
          <StackButton
            key={id}
            id={id}
            dragging={drag?.id === id}
            mark={markBefore ? 'before' : markAfter ? 'after' : null}
            onDrag={(x) => setDrag({ id, to: dropIndex(id, x) })}
            onDrop={(x) => {
              setDrag(null)
              if (x !== null) movePanel(id, dropIndex(id, x))
            }}
          />
        )
      })}
    </div>
  )
}

function StackButton(props: {
  id: PanelId
  dragging: boolean
  mark: 'before' | 'after' | null
  /** the pointer moved to x while dragging this button */
  onDrag: (x: number) => void
  /** released at x (null: cancelled) */
  onDrop: (x: number | null) => void
}): React.JSX.Element {
  const { id, dragging, mark, onDrag, onDrop } = props
  const meta = metaOf(id)
  const root = useStore((s) => s.root)
  const page = useStore((s) => (isPage(id) ? pageTab(s, id) : undefined))
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id)
  const files = useStore((s) => (id === 'code' ? s.tabs.length : 0))
  const running = useStore((s) => (id === 'agents' ? s.chats.filter((c) => c.status === 'working').length : 0))
  // Agent: named after the agent of the chat you are in ("Claude Code", "Codex"…)
  const agent = useStore((s) => (id === 'agents' ? agentDef(s.chats.find((c) => c.id === s.activeChatId)?.agent).label : ''))
  const [menu, setMenu] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const clickTimer = useRef<number | undefined>(undefined)
  // a drag ends with a click on the button: that one is not a click
  const dragged = useRef(false)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!(e.target instanceof Element && e.target.closest('.stack-menu'))) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const press = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const btn = e.currentTarget
    const startX = e.clientX
    let moving = false
    dragged.current = false
    const move = (ev: PointerEvent): void => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_START) return
      if (!moving) {
        moving = true
        dragged.current = true
        btn.setPointerCapture(ev.pointerId)
        window.clearTimeout(clickTimer.current)
        closeFloat()
      }
      onDrag(ev.clientX)
    }
    const end = (ev: PointerEvent): void => {
      btn.removeEventListener('pointermove', move)
      btn.removeEventListener('pointerup', end)
      btn.removeEventListener('pointercancel', end)
      if (moving) onDrop(ev.type === 'pointerup' ? ev.clientX : null)
    }
    btn.addEventListener('pointermove', move)
    btn.addEventListener('pointerup', end)
    btn.addEventListener('pointercancel', end)
  }

  const click = (e: React.MouseEvent): void => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    window.clearTimeout(clickTimer.current)
    if (e.detail >= 2) {
      setMenu(false)
      togglePin(id)
      return
    }
    // wait: this may be the first half of a double-click
    clickTimer.current = window.setTimeout(() => {
      if (id === 'project') setMenu((m) => !m)
      else togglePanel(id)
    }, CLICK_WAIT)
  }

  const Icon = meta.icon
  const label = id === 'project' && root ? basename(root) : id === 'agents' && agent ? agent : page ? page.title || page.url.replace(/^https?:\/\//, '') || meta.label : meta.label
  const keys = keysOf(id)
  const what = id === 'project' ? 'click for folders' : 'click to open'
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.clearTimeout(clickTimer.current)
    setMenu(false)
    setCtx({ x: e.clientX, y: e.clientY })
  }
  return (
    <div className={`stack-btn-wrap${mark ? ` mark-${mark}` : ''}`}>
      <button
        className={`stack-btn${shown ? ' on' : ''}${pinned ? ' pinned' : ''}${dragging ? ' dragging' : ''}`}
        data-panel={id}
        aria-label={label}
        title={`${label}: hover to look, ${what}, double-click to ${pinned ? 'unpin' : 'pin'}, right-click for more, drag to reorder${keys ? ` (${keys})` : ''}`}
        onMouseEnter={() => !dragging && peekPanel(id)}
        onPointerDown={press}
        onClick={click}
        onContextMenu={openMenu}
      >
        {page ? <SiteIcon url={page.url} size={14} /> : <Icon size={13} />}
        {files > 0 && <span className="center-count">{files}</span>}
        {running > 0 && <span className="center-count">{running}</span>}
      </button>
      {menu && <FolderMenu close={() => setMenu(false)} />}
      {ctx && <StackMenu id={id} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
    </div>
  )
}

/** Right-click on a title-bar button: pin, open / close, move, reset width (like a tab in Chrome). */
function StackMenu({ id, x, y, onClose }: { id: PanelId; x: number; y: number; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ left: x, top: y, visibility: 'hidden' })
  const pinned = useStore((s) => s.pinned.includes(id))
  const open = useStore((s) => floating(s) === id)
  const order = useStore((s) => s.panelOrder)
  const key = useStore((s) => (isPage(id) ? pageKey(s, id) : undefined))
  const chatKey = useStore((s) => browserKey(s.activeChatId))
  const at = order.indexOf(id)
  const keys = keysOf(id)

  // kept on screen, measured before paint so it never jumps
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const run = (f: () => void) => (): void => {
    onClose()
    f()
  }
  type Item = { icon: React.ReactNode; label: string; hint?: string; act: () => void; off?: boolean } | 'sep'
  const items: Item[] = [
    pinned
      ? { icon: <PinOff size={14} />, label: 'Unpin', hint: 'Double-click', act: () => togglePin(id) }
      : { icon: <Pin size={14} />, label: 'Pin', hint: 'Double-click', act: () => togglePin(id) },
    // a pinned one is always on screen: nothing to open or close
    ...(pinned
      ? []
      : [
          open
            ? { icon: <X size={14} />, label: 'Close', hint: keys, act: () => closeFloat() }
            : { icon: <PanelTop size={14} />, label: 'Open', hint: keys, act: () => showPanel(id) }
        ]),
    'sep',
    { icon: <ArrowLeft size={14} />, label: 'Move left', act: () => movePanel(id, at - 1), off: at <= 0 },
    { icon: <ArrowRight size={14} />, label: 'Move right', act: () => movePanel(id, at + 1), off: at >= order.length - 1 },
    'sep',
    { icon: <MoveHorizontal size={14} />, label: 'Reset width', act: () => window.dispatchEvent(new CustomEvent('stack-reset-width', { detail: id })) },
    ...(isPage(id) && key
      ? [
          'sep' as const,
          { icon: <Globe size={14} />, label: 'Back to the Web tabs', act: () => attachBrowserTab(key, id.slice(5)) },
          { icon: <X size={14} />, label: 'Close this page', act: () => closeBrowserTab(key, id.slice(5)) }
        ]
      : []),
    ...(id === 'web' || isPage(id)
      ? [
          'sep' as const,
          { icon: <X size={14} />, label: 'Close all tabs', act: () => closeAllBrowserTabs(key ?? chatKey) }
        ]
      : [])
  ]

  // portal to <body>: inside the title bar a transformed / blurred ancestor breaks position:fixed
  return createPortal(
    <div ref={ref} className="menu ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep${i}`} className="ctx-divider" />
        ) : (
          <button key={it.label} className="menu-item" disabled={it.off} onClick={run(it.act)}>
            {it.icon}
            <span className="menu-item-main">{it.label}</span>
            {it.hint && <span className="menu-item-sub ctx-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** The project button's menu: open another folder. */
function FolderMenu({ close }: { close: () => void }): React.JSX.Element {
  const root = useStore((s) => s.root)
  const recent = useStore((s) => s.recent)
  return (
    <div className="menu stack-menu">
      <button
        className="menu-item"
        onClick={() => {
          close()
          openFolder()
        }}
      >
        <FolderOpen size={14} /> Open folder…
      </button>
      {recent.length > 1 && <div className="menu-sep">Recent</div>}
      {recent
        .filter((r) => r !== root)
        .map((r) => (
          <button
            key={r}
            className="menu-item"
            onClick={() => {
              close()
              openFolder(r)
            }}
          >
            <Clock size={14} />
            <span className="menu-item-main">{basename(r)}</span>
            <span className="menu-item-sub">{r}</span>
          </button>
        ))}
    </div>
  )
}

/* ---------------- the stack ---------------- */

/** What counts as "on the floating drop-down": it, the title-bar buttons, and menus / dialogs opened from it. */
const FLOAT_PARTS =
  '.stack-panel.floating, .stack-bar, .menu, .ctx-menu, .overlay, .context-view, .monaco-menu-container, .image-lightbox, .bm-menu, .browser-sugg, .term-image-hover, .plan-pop'

/**
 * A hovered drop-down follows the pointer: it hides a moment after the pointer moves onto the rest
 * of the app. That is read from where the pointer moves, not from leaving the drop-down: over a web
 * page the pointer is in the native page and the app sees no event at all (a mouseleave would hide
 * the page you are using). A click elsewhere in the app closes whatever floats.
 */
function useFloatTracking(): void {
  const peeking = useStore((s) => s.peek !== null)
  const shown = useStore((s) => floating(s) !== null)
  useEffect(() => {
    if (!peeking) return
    const move = (e: MouseEvent): void => {
      const t = e.target
      // on a title-bar button, that button decides: another unpinned one floats instead, a pinned
      // one hides what floats (the bar as a whole only bridges the gap between buttons)
      const btn = t instanceof Element ? t.closest<HTMLElement>('.stack-btn[data-panel]') : null
      if (btn) return peekPanel(btn.dataset.panel as PanelId)
      if (t instanceof Element && t.closest(FLOAT_PARTS)) {
        const id = useStore.getState().peek
        if (id) peekPanel(id)
      } else leavePanel()
    }
    window.addEventListener('mousemove', move, true)
    return () => window.removeEventListener('mousemove', move, true)
  }, [peeking])
  useEffect(() => {
    if (!shown) return
    const down = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Element && t.closest(FLOAT_PARTS)) return
      closeFloat()
    }
    window.addEventListener('mousedown', down, true)
    // focus moving elsewhere (a click into the chat's terminal, Alt+Tab back…) closes it too
    const focus = (e: FocusEvent): void => {
      const t = e.target
      if (t instanceof Element && !t.closest(FLOAT_PARTS)) closeFloat()
    }
    window.addEventListener('focusin', focus, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('focusin', focus, true)
    }
  }, [shown])
}

/**
 * The workbench: pinned drop-downs side by side in the title bar's order, the last one (the chat,
 * when it is pinned) stretched over the rest; floating ones over them, under their button. Every
 * drop-down is mounted once, in a fixed place, whatever it does: pinning, floating or reordering
 * only changes its CSS, so the chat's terminals, editors, pages and scroll positions survive.
 * `children` is the chat, shown in the Agent drop-down.
 */
export function StackLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  useFloatTracking()
  const shown = useStore((s) => floating(s) !== null)
  const pinned = useStore((s) => s.pinned)
  const order = useStore((s) => s.panelOrder)
  const browsers = useStore((s) => s.browsers)
  // the torn-off tabs that still exist
  const pageExists = new Set<string>(Object.values(browsers).flatMap((b) => b.tabs.filter((t) => t.detached).map((t) => `page:${t.id}`)))
  // the one that takes the room left: the chat if pinned, else the last pinned one
  const fill = pinned.includes('agents') ? 'agents' : [...order].reverse().find((p) => pinned.includes(p))
  /*
   * Who resizes whom. The stretched one has no width to drag. A drop-down left of it is dragged by
   * its own right edge; one right of it is dragged by its left edge, which is the right edge of the
   * pinned one before it (the window's edge, where the last one ends, can't be dragged, and a
   * native page laid over its panel would swallow the press).
   */
  const line = order.filter((p) => pinned.includes(p))
  const fillAt = fill ? line.indexOf(fill) : -1
  const controls = (id: PanelId): PanelId | null => {
    const next = line[line.indexOf(id) + 1]
    return next && line.indexOf(next) > fillAt ? next : null
  }
  return (
    <div className="workbench stack">
      <TabHosts />
      {[...PANEL_IDS, ...order.filter(isPage).filter((id) => pageExists.has(id))].map((id) => (
        <StackPanel
          key={id}
          id={id}
          fill={id === fill}
          afterFill={pinned.includes(id) && fillAt >= 0 && line.indexOf(id) > fillAt}
          controls={pinned.includes(id) ? controls(id) : null}
        >
          {id === 'agents' ? <AgentSplit>{children}</AgentSplit> : isPage(id) ? <Adopt tabId={id.slice(5)} className="page-pane" /> : <PanelBody id={id} />}
        </StackPanel>
      ))}
      {!fill && <div className="stack-empty">Hover a button in the title bar to look at it, double-click it to pin it here.</div>}
      {/* dims what is behind a floating drop-down; a click on it closes it (useFloatTracking) */}
      <div className={`stack-backdrop${shown ? ' shown' : ''}`} />
    </div>
  )
}

function StackPanel(props: {
  id: PanelId
  fill: boolean
  /** pinned, right of the stretched one: dragged by its left edge, from the panel before it */
  afterFill: boolean
  /** the pinned drop-down whose left edge is this one's right edge */
  controls: PanelId | null
  children: React.ReactNode
}): React.JSX.Element {
  const { id, fill, afterFill, controls, children } = props
  const meta = metaOf(id)
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id)
  const order = useStore((s) => s.panelOrder.indexOf(id))
  const [width, startResize, resetWidth] = useWidth(meta.size)
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(0)

  // floating: under its title-bar button, kept inside the workbench
  useLayoutEffect(() => {
    if (pinned || !shown) return
    const place = (): void => {
      const box = ref.current?.parentElement?.getBoundingClientRect()
      const btn = document.querySelector(`.stack-btn[data-panel="${id}"]`)?.getBoundingClientRect()
      if (!box || !btn) return
      const w = Math.min(width, box.width)
      setLeft(Math.round(Math.max(0, Math.min(btn.left - box.left, box.width - w))))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [pinned, shown, width, id])

  // the panel before this one drags this one's left edge: it hands the press over
  useEffect(() => {
    const begin = (e: Event): void => {
      const d = (e as CustomEvent<{ id: PanelId; event: React.PointerEvent<HTMLDivElement> }>).detail
      if (d.id === id && ref.current) startResize(d.event, ref.current)
    }
    window.addEventListener('stack-resize-start', begin)
    return () => window.removeEventListener('stack-resize-start', begin)
  })

  // "Reset width" in the button's right-click menu
  useEffect(() => {
    const reset = (e: Event): void => {
      if ((e as CustomEvent<PanelId>).detail === id) resetWidth()
    }
    window.addEventListener('stack-reset-width', reset)
    return () => window.removeEventListener('stack-reset-width', reset)
  }, [id, resetWidth])

  return (
    <div
      ref={ref}
      className={`stack-panel ${pinned ? 'pinned' : 'floating'}${shown ? ' shown' : ''}${pinned && fill ? ' fill' : ''}`}
      data-panel={id}
      style={pinned ? { order, flexBasis: width, minWidth: meta.size.min } : { width, left }}
      onMouseEnter={() => !pinned && shown && peekPanel(id)}
    >
      <div className="stack-body">{children}</div>
      {/* the stretched one has no width of its own to drag; one right of it is dragged from the panel before it */}
      {!(pinned && (fill || afterFill)) && (
        <div className="sidebar-resize" title="Drag to resize · double-click to reset" onPointerDown={(e) => startResize(e)} onDoubleClick={resetWidth} />
      )}
      {controls && (
        <div
          className="sidebar-resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={(e) => window.dispatchEvent(new CustomEvent('stack-resize-start', { detail: { id: controls, event: e } }))}
          onDoubleClick={() => window.dispatchEvent(new CustomEvent('stack-reset-width', { detail: controls }))}
        />
      )}
    </div>
  )
}

function PanelBody({ id }: { id: Exclude<StaticPanelId, 'agents'> }): React.JSX.Element {
  switch (id) {
    case 'project':
      return <Sidebar />
    case 'code':
      return <CodePanel />
    case 'web':
      return <WebPanel />
    case 'db':
      return <DbPanel />
    case 'plugins':
      return <PluginManager />
  }
}

/** A drop-down's width: dragged on its right edge, remembered; double-click on the edge resets it. */
function useWidth(size: FloatSize): [number, (e: React.PointerEvent<HTMLDivElement>, leftOf?: HTMLElement) => void, () => void] {
  const [width, setWidth] = useState(() => {
    try {
      return Number(userStore.getItem(size.key)) || size.initial()
    } catch {
      return size.initial()
    }
  })
  const save = (w: number | null): void => {
    try {
      if (w === null) userStore.removeItem(size.key)
      else userStore.setItem(size.key, String(w))
    } catch {
      /* it resets next time */
    }
  }
  /** `leftOf`: the drop-down is dragged by its left edge (the handle belongs to the one before it) */
  const start = (e: React.PointerEvent<HTMLDivElement>, leftOf?: HTMLElement): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const box = (leftOf ?? handle.parentElement!).getBoundingClientRect()
    let w = width
    const move = (ev: PointerEvent): void => {
      const max = Math.max(size.min + 20, window.innerWidth * 0.96)
      w = Math.round(Math.min(max, Math.max(size.min, leftOf ? box.right - ev.clientX : ev.clientX - box.left)))
      setWidth(w)
    }
    const up = (): void => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save(w)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    setWidth(size.initial())
    save(null)
  }
  return [width, start, reset]
}
